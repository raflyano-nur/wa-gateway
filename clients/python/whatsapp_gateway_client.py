from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import requests


class WhatsAppGatewayClient:
    def __init__(self, base_url: str, api_key: Optional[str] = None, timeout: int = 30):
        if not base_url:
            raise ValueError('base_url is required')

        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.timeout = timeout

    def _headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        headers = dict(extra or {})
        if self.api_key:
            headers['X-API-Key'] = self.api_key
        return headers

    def send_text(self, number: str, message: str, session: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {'number': number, 'message': message}
        if session:
            payload['session'] = session

        response = requests.post(
            f'{self.base_url}/api/send',
            json=payload,
            headers=self._headers(),
            timeout=self.timeout,
        )
        return response.json()

    def send_file(self, number: str, file_path: str, caption: Optional[str] = None, session: Optional[str] = None) -> Dict[str, Any]:
        files = {'file': open(file_path, 'rb')}
        payload: Dict[str, Any] = {'number': number}

        if caption:
            payload['caption'] = caption
        if session:
            payload['session'] = session

        try:
            response = requests.post(
                f'{self.base_url}/api/send-file',
                data=payload,
                files=files,
                headers=self._headers(),
                timeout=self.timeout,
            )
            return response.json()
        finally:
            files['file'].close()

    def send_external_text(self, number: str, message: str, session: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {'number': number, 'message': message}
        if session:
            payload['session'] = session

        response = requests.post(
            f'{self.base_url}/api/external/send',
            json=payload,
            headers=self._headers(),
            timeout=self.timeout,
        )
        return response.json()

    def get_status(self, session: Optional[str] = None) -> Dict[str, Any]:
        params = {'session': session} if session else {}
        response = requests.get(
            f'{self.base_url}/api/status',
            params=params,
            headers=self._headers(),
            timeout=self.timeout,
        )
        return response.json()

    def get_history(self, limit: int = 100) -> Dict[str, Any]:
        response = requests.get(
            f'{self.base_url}/api/history',
            params={'limit': limit},
            headers=self._headers(),
            timeout=self.timeout,
        )
        return response.json()
