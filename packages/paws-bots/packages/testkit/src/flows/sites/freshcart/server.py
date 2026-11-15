"""Freshcart: a fake grocery store for live agent flow tests. Python 3 stdlib only."""

import argparse
import datetime
import hmac
import json
import os
import random
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EMAIL = "shopper@example.test"
COOKIE = "fc_session"
HERE = os.path.dirname(os.path.abspath(__file__))
WORDS = ["basil", "mango", "pepper", "olive", "lemon", "cocoa", "maple", "fig"]
STAPLES = ["oat-milk", "eggs-12", "sourdough", "bananas", "cheddar-200", "coffee-beans"]
DELIVERY_FEE, FREE_DELIVERY_FROM = 399, 5000
lock = threading.Lock()

PRODUCTS = [
    (sku, name, size, price, emoji, category)
    for category, items in [
        ("Produce", [
            ("bananas", "Bananas (bunch)", "approx. 6", 149, "🍌"),
            ("organic-bananas", "Organic bananas", "approx. 6", 229, "🍌"),
            ("gala-apples", "Gala apples", "1 kg", 349, "🍎"),
            ("avocados", "Avocados", "2 pack", 300, "🥑"),
            ("baby-spinach", "Baby spinach", "200 g", 279, "🥬"),
            ("cherry-tomatoes", "Cherry tomatoes", "250 g", 299, "🍅"),
            ("carrots", "Carrots", "1 kg", 129, "🥕"),
            ("lemons", "Lemons", "4 pack", 249, "🍋"),
            ("onions", "Yellow onions", "1 kg", 199, "🧅"),
        ]),
        ("Dairy & eggs", [
            ("whole-milk-1l", "Whole milk", "1 L", 139, "🥛"),
            ("whole-milk-2l", "Whole milk", "2 L", 249, "🥛"),
            ("semi-skimmed-2l", "Semi-skimmed milk", "2 L", 239, "🥛"),
            ("oat-milk", "Oat milk", "1 L", 229, "🥛"),
            ("almond-milk", "Almond milk", "1 L", 219, "🥛"),
            ("eggs-6", "Free-range eggs", "6 pack", 219, "🥚"),
            ("eggs-12", "Free-range eggs", "12 pack", 389, "🥚"),
            ("cheddar-200", "Mature cheddar", "200 g", 349, "🧀"),
            ("greek-yogurt", "Greek yogurt", "500 g", 299, "🥣"),
            ("butter", "Salted butter", "250 g", 319, "🧈"),
        ]),
        ("Bakery", [
            ("sourdough", "Sourdough loaf", "800 g", 399, "🍞"),
            ("white-bread", "Sliced white bread", "800 g", 149, "🍞"),
            ("wholemeal-bread", "Sliced wholemeal bread", "800 g", 169, "🍞"),
            ("croissants", "Butter croissants", "4 pack", 299, "🥐"),
            ("bagels", "Plain bagels", "5 pack", 249, "🥯"),
            ("wraps", "Tortilla wraps", "8 pack", 199, "🫓"),
        ]),
        ("Pantry", [
            ("coffee-beans", "Coffee beans", "250 g", 699, "☕"),
            ("ground-coffee", "Ground coffee", "250 g", 549, "☕"),
            ("spaghetti", "Spaghetti", "500 g", 119, "🍝"),
            ("basmati-rice", "Basmati rice", "1 kg", 279, "🍚"),
            ("chopped-tomatoes", "Chopped tomatoes", "400 g", 89, "🥫"),
            ("peanut-butter", "Peanut butter", "340 g", 269, "🥜"),
            ("olive-oil", "Olive oil", "500 ml", 599, "🫒"),
            ("rolled-oats", "Rolled oats", "1 kg", 189, "🌾"),
        ]),
        ("Household", [
            ("dish-soap", "Dish soap", "500 ml", 199, "🧽"),
            ("paper-towels", "Paper towels", "2 rolls", 329, "🧻"),
            ("toilet-paper", "Toilet paper", "9 rolls", 549, "🧻"),
            ("laundry-liquid", "Laundry liquid", "1.5 L", 899, "🧺"),
            ("bin-bags", "Bin bags", "20 pack", 349, "🗑️"),
        ]),
    ]
    for sku, name, size, price, emoji in items
]
BY_SKU = {p[0]: p for p in PRODUCTS}


def derive(seed):
    rng = random.Random(seed)
    # Real dates, so a shopper's "next Monday" exists in the calendar.
    today = datetime.date.today()
    full = rng.randrange(5)
    times = [(1, "9–11 am"), (1, "6–8 pm"), (2, "9–11 am"), (2, "6–8 pm"), (3, "12–2 pm")]
    slots = []
    for i, (days, hours) in enumerate(times):
        day = today + datetime.timedelta(days=days)
        label = f"{day.strftime('%a')} {day.day} {day.strftime('%b')}, {hours}"
        slots.append({"id": f"slot-{i + 1}", "label": label, "date": day.isoformat(), "full": i == full})
    return {
        "password": f"fresh-{rng.choice(WORDS)}-{rng.randrange(10, 100)}",
        "outOfStock": sorted(rng.sample(STAPLES, 2)),
        "today": today.isoformat(),
        "slots": slots,
    }


class Store:
    def __init__(self, seed, state_file):
        self.seed, self.state_file, self.fixed = seed, state_file, derive(seed)
        if state_file and os.path.exists(state_file):
            with open(state_file) as f:
                self.data = json.load(f)
            if self.data.get("seed") == seed:
                return
        self.reset()

    def reset(self):
        self.data = {"seed": self.seed, "codesSent": 0, "pendingCode": None, "logins": 0,
                     "failedLogins": 0, "sessions": [], "orders": []}
        self.save()

    def save(self):
        if self.state_file:
            tmp = self.state_file + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.data, f)
            os.replace(tmp, self.state_file)

    def admin_state(self):
        d = self.data
        return {"seed": self.seed, "credentials": {"email": EMAIL, "password": self.fixed["password"]},
                "outOfStock": self.fixed["outOfStock"], "pendingCode": d["pendingCode"],
                "logins": d["logins"], "failedLogins": d["failedLogins"], "slots": self.fixed["slots"],
                "orders": d["orders"]}

    def product(self, p):
        sku, name, size, price, emoji, category = p
        return {"sku": sku, "name": name, "size": size, "price": price, "emoji": emoji,
                "category": category, "inStock": sku not in self.fixed["outOfStock"]}

    def login(self, body):
        d = self.data
        if body.get("email", "").strip().lower() != EMAIL or body.get("password") != self.fixed["password"]:
            d["failedLogins"] += 1
            self.save()
            return 401, {"error": "Incorrect email or password."}
        d["codesSent"] += 1
        code = random.Random(f"{self.seed}:{d['codesSent']}").randrange(10**6)
        d["pendingCode"] = f"{code:06d}"
        self.save()
        return 200, {"next": "verify"}

    def verify(self, body):
        d = self.data
        if not d["pendingCode"]:
            return 400, {"error": "Sign in first."}
        if str(body.get("code", "")).strip() != d["pendingCode"]:
            d["failedLogins"] += 1
            self.save()
            return 401, {"error": "That code is incorrect."}
        token = secrets.token_hex(16)
        d["pendingCode"] = None
        d["logins"] += 1
        d["sessions"].append(token)
        self.save()
        return 200, {"email": EMAIL}, token

    def order(self, body):
        items = body.get("items")
        if not isinstance(items, list) or not items:
            return 400, {"error": "Your cart is empty."}
        qty_by_sku = {}
        for item in items:
            item = item if isinstance(item, dict) else {}
            sku, qty = item.get("sku"), item.get("qty")
            if sku not in BY_SKU:
                return 400, {"error": f"Unknown product: {sku}"}
            if not isinstance(qty, int) or isinstance(qty, bool) or not 1 <= qty <= 20:
                return 400, {"error": "Quantity must be between 1 and 20."}
            if sku in self.fixed["outOfStock"]:
                return 409, {"error": f"{BY_SKU[sku][1]} ({BY_SKU[sku][2]}) is out of stock."}
            qty_by_sku[sku] = qty_by_sku.get(sku, 0) + qty
            if qty_by_sku[sku] > 20:
                return 400, {"error": "Quantity must be between 1 and 20."}
        slot = next((s for s in self.fixed["slots"] if s["id"] == body.get("slot")), None)
        if not slot:
            return 400, {"error": "Choose a delivery slot."}
        if slot["full"]:
            return 409, {"error": "That delivery slot is full."}
        lines = [{"sku": s, "name": BY_SKU[s][1], "size": BY_SKU[s][2], "qty": q, "unitPrice": BY_SKU[s][3]}
                 for s, q in qty_by_sku.items()]
        subtotal = sum(line["qty"] * line["unitPrice"] for line in lines)
        fee = 0 if subtotal >= FREE_DELIVERY_FROM else DELIVERY_FEE
        orders = self.data["orders"]
        order = {"id": f"FC-{1042 + len(orders)}", "items": lines, "slot": {"id": slot["id"], "label": slot["label"]},
                 "subtotal": subtotal, "deliveryFee": fee, "total": subtotal + fee,
                 "placedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
        orders.append(order)
        self.save()
        return 200, order


class Handler(BaseHTTPRequestHandler):
    store: Store
    admin_token: str

    def log_message(self, *args):
        pass

    def send(self, status, body, headers=()):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "text/html; charset=utf-8" if isinstance(body, bytes) else "application/json")
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        try:
            data = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}

    def session(self):
        for part in (self.headers.get("cookie") or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE and value in self.store.data["sessions"]:
                return value
        return None

    def admin_ok(self):
        return hmac.compare_digest(self.headers.get("x-admin-token") or "", self.admin_token)

    def do_GET(self):
        path, s = self.path.split("?")[0], self.store
        if path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self.send(200, f.read())
        if path == "/__admin/state":
            return self.send(200, s.admin_state()) if self.admin_ok() else self.send(403, {"error": "Forbidden"})
        if not path.startswith("/api/"):
            return self.send(404, {"error": "Not found"})
        if not self.session():
            return self.send(401, {"error": "Sign in required."})
        if path == "/api/me":
            return self.send(200, {"email": EMAIL})
        if path == "/api/products":
            return self.send(200, {"products": [s.product(p) for p in PRODUCTS]})
        if path == "/api/slots":
            return self.send(200, {"slots": s.fixed["slots"], "deliveryFee": DELIVERY_FEE,
                                   "freeDeliveryFrom": FREE_DELIVERY_FROM})
        if path == "/api/orders":
            return self.send(200, {"orders": list(reversed(s.data["orders"]))})
        self.send(404, {"error": "Not found"})

    def do_POST(self):
        path, s = self.path.split("?")[0], self.store
        with lock:
            if path == "/__admin/reset":
                if not self.admin_ok():
                    return self.send(403, {"error": "Forbidden"})
                s.reset()
                return self.send(200, {"ok": True})
            if path == "/api/login":
                return self.send(*s.login(self.body()))
            if path == "/api/verify":
                status, payload, *token = s.verify(self.body())
                cookie = [("set-cookie", f"{COOKIE}={token[0]}; Path=/; HttpOnly; SameSite=Lax")] if token else []
                return self.send(status, payload, cookie)
            if path == "/api/logout":
                token = self.session()
                if token:
                    s.data["sessions"].remove(token)
                    s.save()
                return self.send(200, {"ok": True}, [("set-cookie", f"{COOKIE}=; Path=/; HttpOnly; Max-Age=0")])
            if path == "/api/order":
                if not self.session():
                    return self.send(401, {"error": "Sign in required."})
                return self.send(*s.order(self.body()))
            self.send(404, {"error": "Not found"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--admin-token", required=True)
    parser.add_argument("--state-file")
    args = parser.parse_args()
    Handler.store = Store(args.seed, args.state_file)
    Handler.admin_token = args.admin_token
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Freshcart listening on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()
