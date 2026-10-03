"""How your GitHub bot talks to WorkBuddy. Adapt `do_the_work`.
Run as a small web service (Flask). The admin panel's Bot URL points at /start.
pip install flask requests
"""
import os, hmac, hashlib, threading, requests
from flask import Flask, request, abort

SECRET = os.environ["BOT_SECRET"]          # same value as in Netlify
app = Flask(__name__)

def do_the_work(sid, spass):
    # >>> your existing bot code goes here. Return True on success, False on failure.
    return True

def run(job):
    ok = False
    try:
        c = requests.get(job["credentials_url"], params={"job_id": job["job_id"]},
                         headers={"x-bot-secret": SECRET}, timeout=15).json()
        ok = do_the_work(c["sid"], c["spass"])
    except Exception:
        ok = False
    requests.post(job["callback_url"], json={"job_id": job["job_id"], "success": ok},
                  headers={"x-bot-secret": SECRET}, timeout=15)

@app.post("/start")
def start():
    raw = request.get_data()
    good = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(good, request.headers.get("x-wb-signature", "")):
        abort(403)
    threading.Thread(target=run, args=(request.get_json(),), daemon=True).start()
    return {"ok": True}
