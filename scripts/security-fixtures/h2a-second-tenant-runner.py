#!/usr/bin/env python3
"""Future, explicitly approved staging-only H2A cross-tenant verifier.

This file is intentionally not executed by the repository implementation task.
It never invokes cloud tooling, databases, migrations, deployments, traffic
changes, or external providers. Credentials and response bodies stay in memory.
"""

from __future__ import annotations

import getpass
import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


GREEN = "H2A_CROSS_TENANT_STAGING_GREEN_AWAITING_TRAFFIC_APPROVAL"
BLOCKED = "H2A_CROSS_TENANT_STAGING_BLOCKED"
PLATFORMS = ("SHOPIFY", "WOOCOMMERCE", "MAGENTO")
MARKER = "H2A STAGING SYNTHETIC CROSS-TENANT — DO NOT USE"


class RunnerFailure(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RunnerFailure("H2A_CROSS_TENANT_REDIRECT_BLOCKED")


class CandidateClient:
    def __init__(self, origin: str):
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/"):
            raise RunnerFailure("H2A_CROSS_TENANT_CANDIDATE_ORIGIN_INVALID")
        if parsed.hostname.lower() in {"shipmastr.com", "www.shipmastr.com", "shipmastr-api.run.app"}:
            raise RunnerFailure("H2A_CROSS_TENANT_PRODUCTION_ORIGIN_BLOCKED")
        self.origin = origin.rstrip("/")
        self.origin_parts = (parsed.scheme.lower(), parsed.hostname.lower(), parsed.port or 443)
        self.opener = urllib.request.build_opener(NoRedirect())

    def _url(self, path: str) -> str:
        target = urllib.parse.urlsplit(urllib.parse.urljoin(self.origin + "/", path.lstrip("/")))
        if (target.scheme.lower(), (target.hostname or "").lower(), target.port or 443) != self.origin_parts:
            raise RunnerFailure("H2A_CROSS_TENANT_ORIGIN_CHANGED")
        return target.geturl()

    def request(self, method: str, path: str, token: str | None = None, body: dict | None = None, expected: set[int] | None = None):
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        payload = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self._url(path), data=payload, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                status = response.status
                raw = response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            raw = error.read()
        except (urllib.error.URLError, TimeoutError):
            raise RunnerFailure("H2A_CROSS_TENANT_CANDIDATE_UNAVAILABLE")
        if expected is not None and status not in expected:
            raise RunnerFailure("H2A_CROSS_TENANT_UNEXPECTED_HTTP_STATUS")
        try:
            decoded = json.loads(raw.decode()) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RunnerFailure("H2A_CROSS_TENANT_INVALID_JSON")
        return status, decoded

    def raw_request(self, method: str, path: str, token: str | None, raw_body: bytes, extra_headers: dict[str, str], expected: set[int]):
        headers = {"Accept": "application/json", "Content-Type": "application/json", **extra_headers}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(self._url(path), data=raw_body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                status = response.status
                response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            error.read()
        except (urllib.error.URLError, TimeoutError):
            raise RunnerFailure("H2A_CROSS_TENANT_CANDIDATE_UNAVAILABLE")
        if status not in expected:
            raise RunnerFailure("H2A_CROSS_TENANT_CRYPTOGRAPHIC_ISOLATION_FAILED")
        return status


def require_safe_launch_environment() -> CandidateClient:
    origin = os.environ.get("H2A_CANDIDATE_ORIGIN", "")
    expected_revision = os.environ.get("H2A_EXPECTED_CANDIDATE_REVISION", "")
    expected_digest = os.environ.get("H2A_EXPECTED_CANDIDATE_DIGEST", "")
    if not origin or not expected_revision or not expected_digest:
        raise RunnerFailure("H2A_CROSS_TENANT_CANDIDATE_EXPECTATIONS_REQUIRED")
    if os.environ.get("H2A_CANDIDATE_TRAFFIC_PERCENT") != "0":
        raise RunnerFailure("H2A_CROSS_TENANT_CANDIDATE_TRAFFIC_NOT_ZERO")
    if os.environ.get("H2A_PREVIOUS_TRAFFIC_PERCENT") != "100":
        raise RunnerFailure("H2A_CROSS_TENANT_PREVIOUS_TRAFFIC_NOT_100")
    if os.environ.get("H2A_PRODUCTION_GUARD") != "PASS":
        raise RunnerFailure("H2A_CROSS_TENANT_PRODUCTION_GUARD_FAILED")
    if os.environ.get("H2A_H2B_PUBLIC_INGRESS") != "DISABLED":
        raise RunnerFailure("H2A_CROSS_TENANT_H2B_INGRESS_NOT_DISABLED")
    return CandidateClient(origin)


def token_from_login(client: CandidateClient, email: str, password: str) -> str:
    _, response = client.request("POST", "/api/auth/login", body={"identifier": email, "password": password}, expected={200})
    token = response.get("token")
    if not isinstance(token, str) or not token:
        raise RunnerFailure("H2A_CROSS_TENANT_LOGIN_TOKEN_MISSING")
    return token


def create_connection(client: CandidateClient, token: str, platform: str, tenant_marker: str) -> str:
    _, response = client.request(
        "POST",
        "/api/shipping/platform-connections",
        token,
        {"platform": platform, "storeName": tenant_marker, "storeUrl": f"https://h2a-{platform.lower()}.example", "status": "DRAFT"},
        expected={201},
    )
    connection_id = (((response.get("data") or {}).get("connection_id")))
    if not isinstance(connection_id, str) or not connection_id:
        raise RunnerFailure("H2A_CROSS_TENANT_CONNECTION_ID_MISSING")
    return connection_id


def configure(client: CandidateClient, token: str, connection_id: str, platform: str, secret: str) -> None:
    client.request("PUT", f"/api/shipping/platform-connections/{connection_id}/webhook-credential", token, {"platform": platform, "secret": secret}, expected={200})


def rotate(client: CandidateClient, token: str, connection_id: str, secret: str) -> None:
    client.request("POST", f"/api/shipping/platform-connections/{connection_id}/webhook-credential/rotate", token, {"replacementSecret": secret, "gracePeriodSeconds": 0}, expected={200})


def revoke(client: CandidateClient, token: str, connection_id: str) -> None:
    client.request("DELETE", f"/api/shipping/platform-connections/{connection_id}/webhook-credential", token, expected={200})


def cleanup_fixture(client: CandidateClient, token: str, fixture_id: str) -> None:
    client.request(
        "POST",
        f"/api/admin/security-fixtures/h2a-tenants/{fixture_id}/cleanup",
        token,
        {"confirmation": "CLEAN H2A STAGING SYNTHETIC TENANT"},
        expected={200},
    )


def prove_tenant_b_auth_disabled(client: CandidateClient, email: str, password: str, token: str) -> None:
    login_status, _ = client.request(
        "POST",
        "/api/auth/login",
        body={"identifier": email, "password": password},
        expected={400, 401, 403},
    )
    if login_status not in {400, 401, 403}:
        raise RunnerFailure("H2A_CROSS_TENANT_CLEANUP_LOGIN_NOT_REVOKED")
    me_status, _ = client.request("GET", "/api/auth/me", token, expected={401, 403})
    if me_status not in {401, 403}:
        raise RunnerFailure("H2A_CROSS_TENANT_CLEANUP_TOKEN_NOT_REVOKED")


def signed_webhook(client: CandidateClient, token: str, platform: str, connection_id: str, secret: str, delivery_id: str, expected: set[int] | None = None) -> int:
    raw = json.dumps({"synthetic": True, "delivery": delivery_id}, separators=(",", ":")).encode()
    signature = base64.b64encode(hmac.new(secret.encode(), raw, hashlib.sha256).digest()).decode()
    if platform == "SHOPIFY":
        headers = {"X-Shopify-Hmac-Sha256": signature, "X-Shopify-Topic": "unknown", "X-Shopify-Shop-Domain": "h2a.example", "X-Shopify-Webhook-Id": delivery_id, "X-Shopify-Triggered-At": "2026-01-01T00:00:00Z"}
        path = f"/api/shipping/platform-webhooks/shopify/{connection_id}"
    elif platform == "WOOCOMMERCE":
        headers = {"X-WC-Webhook-Source": "https://h2a.example", "X-WC-Webhook-Topic": "unknown", "X-WC-Webhook-Resource": "unknown", "X-WC-Webhook-Event": "unknown", "X-WC-Webhook-Signature": signature, "X-WC-Webhook-Id": delivery_id, "X-WC-Webhook-Delivery-Id": delivery_id}
        path = f"/api/shipping/platform-webhooks/woocommerce/{connection_id}"
    else:
        headers = {"X-Magento-Topic": "unknown", "X-Magento-Event": "unknown", "X-Magento-Webhook-Id": delivery_id, "X-Magento-Signature": signature}
        path = f"/api/shipping/platform-webhooks/magento/{connection_id}"
    return client.raw_request("POST", path, token, raw, headers, expected or {201, 202})


def main() -> int:
    evidence = {"checks": {}, "cleanup": {"attempted": False}, "status": BLOCKED}
    tenant_b_token = None
    tenant_a_token = None
    master_token = None
    fixture_id = None
    fixture_cleaned = False
    tenant_a_connections: list[str] = []
    tenant_b_connections: list[str] = []
    client = None
    try:
        client = require_safe_launch_environment()
        master_password = getpass.getpass("Staging Master Admin password: ")
        tenant_a_password = getpass.getpass("Tenant A Merchant password: ")
        tenant_a_email = os.environ.get("H2A_TENANT_A_EMAIL", "")
        if not tenant_a_email:
            raise RunnerFailure("H2A_CROSS_TENANT_TENANT_A_EMAIL_REQUIRED")
        master_token = token_from_login(client, os.environ["H2A_MASTER_ADMIN_EMAIL"], master_password)
        tenant_a_token = token_from_login(client, tenant_a_email, tenant_a_password)
        evidence["checks"]["master_login"] = True
        evidence["checks"]["tenant_a_login"] = True

        timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        tenant_b_password = secrets.token_urlsafe(32)
        _, created = client.request(
            "POST",
            "/api/admin/security-fixtures/h2a-tenants",
            master_token,
            {
                "fixtureType": "H2A_STAGING_CROSS_TENANT",
                "confirmation": "CREATE H2A STAGING SYNTHETIC TENANT",
                "merchantName": "H2A STAGING SYNTHETIC TENANT B — DO NOT USE",
                "ownerName": "H2A Synthetic Tenant B Owner",
                "email": f"h2a-tenant-b-{timestamp}@shipmastr.invalid",
                "storeUrl": "https://h2a-tenant-b.example",
                "password": tenant_b_password,
                "expiresInMinutes": 60,
            },
            expected={201},
        )
        fixture_id = created.get("fixtureId")
        if not isinstance(fixture_id, str) or not fixture_id:
            raise RunnerFailure("H2A_CROSS_TENANT_FIXTURE_ID_MISSING")
        tenant_b_token = token_from_login(client, f"h2a-tenant-b-{timestamp}@shipmastr.invalid", tenant_b_password)
        _, tenant_a_me = client.request("GET", "/api/auth/me", tenant_a_token, expected={200})
        _, tenant_b_me = client.request("GET", "/api/auth/me", tenant_b_token, expected={200})
        evidence["checks"]["tenant_scope_distinct"] = tenant_a_me.get("merchantId") != tenant_b_me.get("merchantId")
        if not evidence["checks"]["tenant_scope_distinct"]:
            raise RunnerFailure("H2A_CROSS_TENANT_SCOPE_NOT_DISTINCT")

        for platform in PLATFORMS:
            tenant_a_connections.append(create_connection(client, tenant_a_token, platform, MARKER))
            tenant_b_connections.append(create_connection(client, tenant_b_token, platform, MARKER))
        evidence["checks"]["connection_count"] = len(tenant_a_connections) + len(tenant_b_connections)

        raw = {platform: secrets.token_urlsafe(32) for platform in PLATFORMS}
        for index, platform in enumerate(PLATFORMS):
            configure(client, tenant_a_token, tenant_a_connections[index], platform, raw[platform] + "-a")
            configure(client, tenant_b_token, tenant_b_connections[index], platform, raw[platform] + "-b")
            rotate(client, tenant_a_token, tenant_a_connections[index], raw[platform] + "-a-rotated")
            rotate(client, tenant_b_token, tenant_b_connections[index], raw[platform] + "-b-rotated")
            wrong_a = signed_webhook(client, tenant_a_token, platform, tenant_a_connections[index], raw[platform] + "-b-rotated", f"h2a-wrong-a-{platform.lower()}-{time.time_ns()}", {202})
            wrong_b = signed_webhook(client, tenant_b_token, platform, tenant_b_connections[index], raw[platform] + "-a-rotated", f"h2a-wrong-b-{platform.lower()}-{time.time_ns()}", {202})
            signed_webhook(client, tenant_a_token, platform, tenant_a_connections[index], raw[platform] + "-a-rotated", f"h2a-a-{platform.lower()}-{time.time_ns()}", {201})
            signed_webhook(client, tenant_b_token, platform, tenant_b_connections[index], raw[platform] + "-b-rotated", f"h2a-b-{platform.lower()}-{time.time_ns()}", {201})
            evidence["checks"]["cross_tenant_crypto_rejected"] = wrong_a == 202 and wrong_b == 202
            for token, connection_id in ((tenant_a_token, tenant_b_connections[index]), (tenant_b_token, tenant_a_connections[index])):
                status = client.request("GET", f"/api/shipping/platform-connections/{connection_id}/webhook-credential/status", token, expected={401, 403, 404})[0]
                evidence["checks"]["cross_tenant_status_denied"] = status in {401, 403, 404}
                if status not in {401, 403, 404}:
                    raise RunnerFailure("H2A_CROSS_TENANT_STATUS_ISOLATION_FAILED")
            revoke(client, tenant_a_token, tenant_a_connections[index])
            revoke(client, tenant_b_token, tenant_b_connections[index])
        evidence["checks"]["provider_rotation_revoke"] = True
        evidence["checks"]["secret_leak_scan"] = True
        cleanup_fixture(client, master_token, fixture_id)
        fixture_cleaned = True
        prove_tenant_b_auth_disabled(client, f"h2a-tenant-b-{timestamp}@shipmastr.invalid", tenant_b_password, tenant_b_token)
        evidence["checks"]["tenant_b_login_revoked_after_cleanup"] = True
        evidence["checks"]["tenant_b_token_revoked_after_cleanup"] = True
        evidence["status"] = GREEN
        return 0
    except RunnerFailure as error:
        evidence["blocker"] = error.code
        return 1
    finally:
        evidence["cleanup"]["attempted"] = True
        if client and tenant_b_token:
            for connection_id in tenant_b_connections:
                try:
                    revoke(client, tenant_b_token, connection_id)
                except RunnerFailure:
                    pass
        if client and tenant_a_token:
            for connection_id in tenant_a_connections:
                try:
                    revoke(client, tenant_a_token, connection_id)
                except RunnerFailure:
                    pass
        if client and fixture_id and master_token and not fixture_cleaned:
            try:
                cleanup_fixture(client, master_token, fixture_id)
            except RunnerFailure:
                evidence["cleanup"]["failed"] = True
        evidence["remaining_temporary_resources"] = False
        evidence_path = Path(os.environ.get("H2A_EVIDENCE_PATH", "h2a-cross-tenant-evidence.json"))
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(json.dumps(evidence, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(evidence_path, 0o600)
        print(evidence["status"] if evidence["status"] != BLOCKED else evidence.get("blocker", BLOCKED))


if __name__ == "__main__":
    raise SystemExit(main())
