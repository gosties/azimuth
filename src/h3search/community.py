"""Durable account feedback, notifications, and published announcements."""

import json
import time
from contextlib import contextmanager
from uuid import uuid4

from fastapi import HTTPException

from .auth import Accounts, PermissionDenied, _token_hash
from .models import utc_now

WELCOME_ID = "00000000-0000-4000-8000-000000000001"
WELCOME = {
    "title": "Welcome to Azimuth",
    "body": "You’re one of the first people personally invited to explore Azimuth. As a beta tester, your experience will help shape what comes next. We appreciate any and all feedback—share observations, report issues, or suggest improvements using Feedback.",
    "image_data_url": None, "image_alt": "",
}
SCHEMA = (
    "CREATE TABLE IF NOT EXISTS feedback_threads (id TEXT PRIMARY KEY, author_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, author_email TEXT NOT NULL, category TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submission_id TEXT, UNIQUE(author_id,submission_id))",
    "CREATE INDEX IF NOT EXISTS feedback_author ON feedback_threads(author_id,created_at)",
    "CREATE TABLE IF NOT EXISTS feedback_comments (id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE, author_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, author_email TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, submission_id TEXT, UNIQUE(author_id,submission_id))",
    "CREATE INDEX IF NOT EXISTS feedback_comment_thread ON feedback_comments(feedback_id,created_at)",
    "CREATE TABLE IF NOT EXISTS community_notifications (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, feedback_id TEXT NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE, management INTEGER NOT NULL, event TEXT NOT NULL, message TEXT NOT NULL, created DOUBLE PRECISION NOT NULL, read_at DOUBLE PRECISION)",
    "CREATE INDEX IF NOT EXISTS community_notification_owner ON community_notifications(owner,created)",
    "CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, draft TEXT NOT NULL, snapshot TEXT, revision INTEGER NOT NULL, published INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS announcement_dismissals (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE, revision INTEGER NOT NULL, PRIMARY KEY(account_id,announcement_id))",
)


def initialize(conn):
    for statement in SCHEMA:
        conn.execute(statement)
    now = utc_now()
    payload = json.dumps(WELCOME)
    conn.execute("INSERT INTO announcements (id,draft,snapshot,revision,published,created_at,updated_at) VALUES (?,?,?,1,1,?,?) ON CONFLICT DO NOTHING", (WELCOME_ID, payload, payload, now, now))


class Community:
    def __init__(self, registry):
        self.registry = registry

    @contextmanager
    def session(self, token, *, write=False, admin=False):
        with self.registry.connect() as conn:
            if write:
                conn.execute("UPDATE account_mutex SET singleton=1 WHERE singleton=1")
            user = Accounts._session(conn, _token_hash(token))
            if not user or (admin and user["role"] != "superadmin"):
                raise PermissionDenied
            yield conn, user

    @staticmethod
    def thread(conn, user, identifier, comments=False):
        row = conn.execute("SELECT * FROM feedback_threads WHERE id=?", (identifier,)).fetchone()
        if row is None or (row["author_id"] != user["id"] and user["role"] != "superadmin"):
            raise HTTPException(404, "Feedback not found")
        item = dict(row)
        item.pop("submission_id", None)
        if comments:
            rows = conn.execute("SELECT id,body,created_at,author_id,author_email FROM feedback_comments WHERE feedback_id=? ORDER BY created_at,id LIMIT 200", (identifier,)).fetchall()
            item["comments"] = [dict(row) for row in rows]
        return item

    @staticmethod
    def notify(conn, owner, identifier, management, event, message):
        conn.execute("INSERT INTO community_notifications (id,owner,feedback_id,management,event,message,created) VALUES (?,?,?,?,?,?,?)", (str(uuid4()), owner, identifier, int(management), event, message, time.time()))

    def list_feedback(self, token, limit, offset, admin=False):
        with self.session(token, admin=admin) as (conn, user):
            where, args = ("", ()) if admin else (" WHERE author_id=?", (user["id"],))
            total = conn.execute("SELECT count(*) AS total FROM feedback_threads" + where, args).fetchone()["total"]
            rows = conn.execute("SELECT id FROM feedback_threads" + where + " ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
            return {"items": [self.thread(conn, user, row["id"]) for row in rows], "total": total}

    def get_feedback(self, token, identifier):
        with self.session(token) as (conn, user):
            return self.thread(conn, user, identifier, True)

    def create_feedback(self, token, payload):
        with self.session(token, write=True) as (conn, user):
            submission = payload.get("submission_id")
            if submission:
                row = conn.execute("SELECT id,category,subject,body FROM feedback_threads WHERE author_id=? AND submission_id=?", (user["id"], submission)).fetchone()
                if row:
                    if any(row[key] != payload[key] for key in ("category", "subject", "body")):
                        raise HTTPException(409, "Submission identifier already used")
                    return self.thread(conn, user, row["id"], True)
            identifier, now = str(uuid4()), utc_now()
            conn.execute("INSERT INTO feedback_threads (id,author_id,author_email,category,subject,body,status,created_at,updated_at,submission_id) VALUES (?,?,?,?,?,?,'new',?,?,?)", (identifier, user["id"], user["email"], payload["category"], payload["subject"], payload["body"], now, now, submission))
            for admin in conn.execute("SELECT id FROM accounts WHERE role='superadmin' AND active=1").fetchall():
                self.notify(conn, admin["id"], identifier, True, "feedback", "New feedback: " + payload["subject"])
            return self.thread(conn, user, identifier, True)

    def comment(self, token, identifier, payload):
        with self.session(token, write=True) as (conn, user):
            thread = self.thread(conn, user, identifier)
            submission = payload.get("submission_id")
            if submission:
                previous = conn.execute("SELECT * FROM feedback_comments WHERE author_id=? AND submission_id=?", (user["id"], submission)).fetchone()
                if previous:
                    if previous["feedback_id"] != identifier or previous["body"] != payload["body"]:
                        raise HTTPException(409, "Submission identifier already used")
                    return {key: previous[key] for key in ("id", "body", "created_at", "author_id", "author_email")}
            count = conn.execute("SELECT count(*) AS total FROM feedback_comments WHERE feedback_id=?", (identifier,)).fetchone()["total"]
            if count >= 200:
                raise HTTPException(409, "This feedback has reached its comment limit")
            comment_id, now = str(uuid4()), utc_now()
            conn.execute("INSERT INTO feedback_comments (id,feedback_id,author_id,author_email,body,created_at,submission_id) VALUES (?,?,?,?,?,?,?)", (comment_id, identifier, user["id"], user["email"], payload["body"], now, submission))
            conn.execute("UPDATE feedback_threads SET updated_at=? WHERE id=?", (now, identifier))
            if user["role"] == "superadmin":
                if thread["author_id"] and thread["author_id"] != user["id"]:
                    self.notify(conn, thread["author_id"], identifier, False, "reply", "Reply to your feedback: " + thread["subject"])
            for admin in conn.execute("SELECT id FROM accounts WHERE role='superadmin' AND active=1").fetchall():
                if admin["id"] != user["id"]:
                    self.notify(conn, admin["id"], identifier, True, "reply", "Feedback comment: " + thread["subject"])
            return {"id": comment_id, "body": payload["body"], "created_at": now, "author_id": user["id"], "author_email": user["email"]}

    def status(self, token, identifier, status):
        with self.session(token, write=True, admin=True) as (conn, user):
            self.thread(conn, user, identifier)
            conn.execute("UPDATE feedback_threads SET status=?,updated_at=? WHERE id=?", (status, utc_now(), identifier))
            return self.thread(conn, user, identifier, True)

    @staticmethod
    def announcement(row, admin=False):
        return {**json.loads(row["draft"] if admin else row["snapshot"]), **{key: row[key] for key in ("id", "revision", "created_at", "updated_at")}, "published": bool(row["published"])}

    def announcements(self, token, mode="unread"):
        with self.session(token, admin=mode == "admin") as (conn, user):
            if mode == "admin":
                rows = conn.execute("SELECT * FROM announcements ORDER BY updated_at DESC,id LIMIT 100").fetchall()
            elif mode == "history":
                rows = conn.execute("SELECT * FROM announcements WHERE published=1 ORDER BY updated_at DESC,id LIMIT 50").fetchall()
            else:
                rows = conn.execute("SELECT a.* FROM announcements a LEFT JOIN announcement_dismissals d ON d.announcement_id=a.id AND d.account_id=? WHERE a.published=1 AND (d.revision IS NULL OR d.revision<a.revision) ORDER BY a.updated_at,a.id LIMIT 50", (user["id"],)).fetchall()
            return {"items": [self.announcement(row, mode == "admin") for row in rows]}

    def save_announcement(self, token, payload, identifier=None, action=None):
        with self.session(token, write=True, admin=True) as (conn, user):
            now = utc_now()
            if identifier is None:
                if conn.execute("SELECT count(*) AS total FROM announcements").fetchone()["total"] >= 100:
                    raise HTTPException(409, "Announcement limit reached")
                identifier = str(uuid4())
                conn.execute("INSERT INTO announcements (id,draft,revision,published,created_at,updated_at) VALUES (?,?,0,0,?,?)", (identifier, json.dumps(payload), now, now))
            else:
                row = conn.execute("SELECT * FROM announcements WHERE id=?", (identifier,)).fetchone()
                if row is None:
                    raise HTTPException(404, "Announcement not found")
                if action == "publish":
                    conn.execute("UPDATE announcements SET snapshot=draft,revision=revision+1,published=1,updated_at=? WHERE id=?", (now, identifier))
                elif action == "unpublish":
                    conn.execute("UPDATE announcements SET published=0,updated_at=? WHERE id=?", (now, identifier))
                else:
                    conn.execute("UPDATE announcements SET draft=?,updated_at=? WHERE id=?", (json.dumps(payload), now, identifier))
            return self.announcement(conn.execute("SELECT * FROM announcements WHERE id=?", (identifier,)).fetchone(), True)

    def dismiss(self, token, identifier, revision):
        with self.session(token, write=True) as (conn, user):
            row = conn.execute("SELECT revision,published FROM announcements WHERE id=?", (identifier,)).fetchone()
            if row is None or not row["published"]:
                raise HTTPException(404, "Announcement not found")
            if row["revision"] != revision:
                raise HTTPException(409, "Announcement has a newer revision")
            conn.execute("INSERT INTO announcement_dismissals (account_id,announcement_id,revision) VALUES (?,?,?) ON CONFLICT(account_id,announcement_id) DO UPDATE SET revision=excluded.revision", (user["id"], identifier, revision))

    def notifications(self, token):
        with self.session(token) as (conn, user):
            args = (user["id"], int(user["role"] == "superadmin"))
            where = " WHERE owner=? AND (management=0 OR ?=1)"
            rows = conn.execute("SELECT * FROM community_notifications" + where + " ORDER BY created DESC,id DESC LIMIT 200", args).fetchall()
            unread = conn.execute("SELECT count(*) AS total FROM community_notifications" + where + " AND read_at IS NULL", args).fetchone()["total"]
            return {"items": [{**{key: row[key] for key in ("id", "feedback_id", "event", "message", "created", "read_at")}, "export_id": None, "download_url": None, "unread": row["read_at"] is None} for row in rows], "unread_count": unread}

    def notification_action(self, token, action, identifier=None):
        with self.session(token, write=True) as (conn, user):
            where = " WHERE owner=? AND (management=0 OR ?=1)"
            args = (user["id"], int(user["role"] == "superadmin"))
            if identifier:
                where += " AND id=?"
                args += (identifier,)
            if action == "read":
                result = conn.execute("UPDATE community_notifications SET read_at=COALESCE(read_at,?)" + where, (time.time(), *args))
            else:
                result = conn.execute("DELETE FROM community_notifications" + where, args)
            return result.rowcount > 0
