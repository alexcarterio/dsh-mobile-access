# -*- coding: utf-8 -*-
"""
DSH session state watcher — precise event-stream folding.

Data sources:
  1. ~/.dsh/sessions/<workspace>/<session-id>/session.jsonl.zstd
     DSH's session event log (zstd-compressed JSONL, appended line by line),
     used to determine precisely:
       - waiting_user: the model called the ask_user_question tool (a user
         question) and is suspended, or an approval/asked event is pending
         -> only then report "needs user action"
       - turn_done: a turn/end event -> only report "done" when a whole work
         turn truly ended
     (An older version wrongly treated pendingCalls — ordinary in-flight tool
     calls — as waiting-for-user; that has been fixed.)
  2. ~/.dsh/storages/session_projcache.json title projection (session titles)

Event semantics per @deepseek-ai/dsh-session-stats and dsh-user-approval source:
  tool/call   -> data.callId enters pendingCalls, data.name is the tool name
  tool/result -> the matching callId leaves pendingCalls
  step/start  -> openStep non-empty (working); assistant/message, step/end -> cleared
  approval/asked / approval/decided -> approval pending / decided
"""
import json
import os

import zstandard

PROJCACHE_NAME = "session_projcache.json"

EVENT_STARTED = "started"
EVENT_TURN_DONE = "turn_done"
EVENT_WAITING_USER = "waiting_user"

QUESTION_TOOLS = {"ask_user_question"}

# Only track session files written within the last N hours (archived sessions
# are naturally filtered out).
RECENT_WINDOW_H = 24


def default_dsh_home():
    """DSH user data directory; overridable via the DSH_HOME environment variable."""
    return os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")


def _find_call_id(ev):
    """Extract the callId from an event (tolerant of different event shapes)."""
    d = ev.get("data")
    if not isinstance(d, dict):
        return None
    for k in ("callId", "id"):
        v = d.get(k)
        if isinstance(v, str):
            return v
    for k in ("message", "source", "result"):
        sub = d.get(k)
        if isinstance(sub, dict):
            for kk in ("callId", "id"):
                v = sub.get(kk)
                if isinstance(v, str):
                    return v
    return None


class SessionTrace:
    """Event-folding state for one session."""
    __slots__ = ("sid", "running", "pending", "waiting", "waiting_kind",
                 "processed_lines", "title", "mtime", "size", "path",
                 "subagent")

    def __init__(self):
        self.sid = ""
        self.running = False      # openStep non-empty: model is thinking
        self.pending = {}         # callId -> tool name (ordinary tool in flight)
        self.waiting = False      # waiting for user (question / approval pending)
        self.waiting_kind = ""    # question | approval
        self.processed_lines = 0  # folded event-line count
        self.title = ""
        self.mtime = 0.0
        self.size = -1
        self.path = ""
        self.subagent = False     # subagent session: do not push notifications


class DshWatch:
    def __init__(self, home_dir=None, on_event=None):
        self.home_dir = home_dir or default_dsh_home()
        self.sessions_dir = os.path.join(self.home_dir, "sessions")
        self.cache_path = os.path.join(self.home_dir, "storages", PROJCACHE_NAME)
        self.on_event = on_event or (lambda event: None)
        self._traces = {}           # session_id -> SessionTrace
        self._dctx = zstandard.ZstdDecompressor()

    # ---------- session file discovery ----------
    def _list_session_files(self):
        """Enumerate recently-active session log files; return {session_id: SessionTrace}."""
        out = {}
        if not os.path.isdir(self.sessions_dir):
            return out
        now = os.path.getmtime(self.cache_path) if os.path.exists(self.cache_path) else 0
        for ws_name in os.listdir(self.sessions_dir):
            ws_dir = os.path.join(self.sessions_dir, ws_name)
            if not os.path.isdir(ws_dir):
                continue
            for sid in os.listdir(ws_dir):
                path = os.path.join(ws_dir, sid, "session.jsonl.zstd")
                if not os.path.isfile(path):
                    continue
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                # Skip archived / long-idle sessions (track only if written within 24h)
                if (now - st.st_mtime) > RECENT_WINDOW_H * 3600:
                    continue
                trace = self._traces.get(sid)
                if trace is None:
                    trace = SessionTrace()
                    trace.path = path
                    self._traces[sid] = trace
                    # subagent sessions are not pushed (main sessions only)
                    trace.subagent = self._is_subagent(path)
                if trace.subagent:
                    continue
                out[sid] = trace
        return out

    def _is_subagent(self, path):
        """Read the first log line to decide whether this is a subagent session (origin=subagent)."""
        try:
            with open(path, "rb") as f:
                chunk = self._dctx.stream_reader(f).read(65536)
            for line in chunk.decode("utf-8", "ignore").splitlines():
                line = line.strip()
                if not line:
                    continue
                ev = json.loads(line)
                return ev.get("origin") == "subagent"
        except Exception:
            return False
        return False

    # ---------- event reading and folding ----------
    def _read_events(self, path):
        """Decompress the whole log and parse it into events; return None when corrupt."""
        try:
            with open(path, "rb") as f:
                raw = self._dctx.stream_reader(f).read()
        except Exception:
            return None
        events = []
        for line in raw.decode("utf-8", "ignore").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except Exception:
                continue
        return events

    def _fold(self, trace, events, emit):
        """Fold new events from trace.processed_lines onward; the first full fold only builds the baseline without emitting."""
        fresh = trace.processed_lines == 0
        for ev in events[trace.processed_lines:]:
            self._apply_event(trace, ev, emit, fresh)
        trace.processed_lines = len(events)

    def _apply_event(self, trace, ev, emit, fresh):
        t = ev.get("type")
        data = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        if t == "step/start":
            trace.running = True
        elif t in ("assistant/message", "step/end"):
            trace.running = False
        elif t == "tool/call":
            cid = _find_call_id(ev)
            name = data.get("name") or ""
            if cid:
                trace.pending[cid] = name
            if name in QUESTION_TOOLS and not trace.waiting:
                trace.waiting = True
                trace.waiting_kind = "question"
                if not fresh:
                    emit(dict(type=EVENT_WAITING_USER, session=trace.sid,
                              title=trace.title, kind="question",
                              tool=name))
        elif t == "tool/result":
            cid = _find_call_id(ev)
            if cid and cid in trace.pending:
                name = trace.pending.pop(cid)
                if name in QUESTION_TOOLS:
                    trace.waiting = False
                    trace.waiting_kind = ""
        elif t == "approval/asked":
            if not trace.waiting:
                trace.waiting = True
                trace.waiting_kind = "approval"
                if not fresh:
                    emit(dict(type=EVENT_WAITING_USER, session=trace.sid,
                              title=trace.title, kind="approval",
                              tool=data.get("toolName") or ""))
        elif t == "approval/decided":
            if trace.waiting and trace.waiting_kind == "approval":
                trace.waiting = False
                trace.waiting_kind = ""
        elif t == "turn/end":
            trace.running = False
            if not fresh:
                emit(dict(type=EVENT_TURN_DONE, session=trace.sid,
                          title=trace.title))

    # ---------- polling ----------
    def poll(self):
        """Poll once; return this round's new events (also dispatched through the on_event callback)."""
        if not os.path.isdir(self.sessions_dir):
            return []
        sessions = self._list_session_files()
        if not sessions:
            return []
        titles = self._read_titles()
        emitted = []

        def emit(ev):
            emitted.append(ev)

        for sid, trace in sessions.items():
            trace.sid = sid
            trace.title = titles.get(sid, trace.title)
            try:
                st = os.stat(trace.path)
            except OSError:
                continue
            changed = (st.st_mtime, st.st_size) != (trace.mtime, trace.size)
            if not changed and trace.processed_lines > 0:
                continue
            trace.mtime, trace.size = st.st_mtime, st.st_size
            evs = self._read_events(trace.path)
            if evs is None:
                continue
            # file rewritten (line count went backwards) -> reset baseline
            if trace.processed_lines > len(evs):
                trace.processed_lines = 0
            self._fold(trace, evs, emit)

        for ev in emitted:
            try:
                self.on_event(ev)
            except Exception:
                pass
        return emitted

    def _read_titles(self):
        """Read session titles from the projection cache."""
        try:
            with open(self.cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return {}
        sessions = (data.get("tables") or {}).get("sessions") or {}
        out = {}
        for sid, rec in sessions.items():
            if not isinstance(rec, dict):
                continue
            row = (rec.get("rows") or {}).get("title")
            val = row.get("val") if isinstance(row, dict) else None
            if isinstance(val, str) and val:
                out[sid] = val
        return out

    def summary(self):
        """Current per-session state summary (event-stream state + projected title).

        Sessions pending for more than 1 hour count as idle: avoids showing
        stale unanswered questions as "waiting for you" forever.
        """
        import time as _time
        now = _time.time()
        titles = self._read_titles()
        out = []
        for sid, tr in self._traces.items():
            waiting = tr.waiting and (now - tr.mtime) < 3600
            if waiting:
                state = "waiting"
            elif tr.running:
                state = "running"
            else:
                state = "idle"
            out.append(dict(session=sid,
                            title=titles.get(sid, tr.title),
                            state=state))
        out.sort(key=lambda x: (x["state"] != "running", x["state"] != "waiting"))
        return out


# ---------- self check ----------
if __name__ == "__main__":
    w = DshWatch()
    print("sessions dir:", w.sessions_dir, "exists:", os.path.isdir(w.sessions_dir))
    ev = w.poll()
    print("baseline events (should be empty):", ev)
    for s in w.summary()[:8]:
        print(f"  [{s['state']:7s}]  {s['title'] or '(untitled)'}  {s['session']}")
