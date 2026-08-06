"""Cloudflare D1 REST 客户端。"""

from __future__ import annotations

import requests


class D1Client:
    def __init__(self, account_id: str, database_id: str, api_token: str):
        self.url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/d1/database/{database_id}/query"
        )
        self.headers = {"Authorization": f"Bearer {api_token}"}

    def query(self, sql: str, params: list | None = None) -> list[dict]:
        """执行 SQL，返回结果行。

        注意：多语句 SQL（';' 分隔）仅返回第一条语句的 results；
        SELECT 请保持单语句，多语句写回不要依赖返回值。
        HTTP 或业务失败抛 RuntimeError / requests.HTTPError。
        """
        resp = requests.post(
            self.url,
            headers=self.headers,
            json={"sql": sql, "params": params or []},
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"D1 query failed: {data.get('errors')}")
        return data["result"][0].get("results", []) if data.get("result") else []
