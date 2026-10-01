<?php

namespace App\Services;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

class WhatsappGatewayService
{
    private Client $http;
    private string $baseUrl;
    private ?string $apiKey;

    public function __construct(string $baseUrl, ?string $apiKey = null)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->apiKey = $apiKey;
        $this->http = new Client([
            'timeout' => 30,
            'http_errors' => false,
        ]);
    }

    private function headers(array $extra = []): array
    {
        $headers = ['Content-Type' => 'application/json'];
        if ($this->apiKey) {
            $headers['X-API-Key'] = $this->apiKey;
        }

        return array_merge($headers, $extra);
    }

    private function request(string $method, string $path, array $options = []): array
    {
        $url = $this->baseUrl . $path;
        $response = $this->http->request($method, $url, $options);

        $body = (string) $response->getBody();
        $decoded = json_decode($body, true);

        return is_array($decoded) ? $decoded : ['success' => false, 'message' => 'Invalid JSON response'];
    }

    public function sendText(string $number, string $message, ?string $session = null): array
    {
        $payload = ['number' => $number, 'message' => $message];
        if ($session) {
            $payload['session'] = $session;
        }

        return $this->request('POST', '/api/send', [
            'headers' => $this->headers(),
            'json' => $payload,
        ]);
    }

    public function sendFile(string $number, string $filePath, ?string $caption = null, ?string $session = null): array
    {
        $multipart = [
            [
                'name' => 'number',
                'contents' => $number,
            ],
            [
                'name' => 'file',
                'contents' => fopen($filePath, 'rb'),
                'filename' => basename($filePath),
            ],
        ];

        if ($caption !== null && $caption !== '') {
            $multipart[] = ['name' => 'caption', 'contents' => $caption];
        }

        if ($session) {
            $multipart[] = ['name' => 'session', 'contents' => $session];
        }

        return $this->request('POST', '/api/send-file', [
            'headers' => $this->headers(['Content-Type' => 'multipart/form-data']),
            'multipart' => $multipart,
        ]);
    }

    public function sendExternalText(string $number, string $message, ?string $session = null): array
    {
        $payload = ['number' => $number, 'message' => $message];
        if ($session) {
            $payload['session'] = $session;
        }

        return $this->request('POST', '/api/external/send', [
            'headers' => $this->headers(),
            'json' => $payload,
        ]);
    }

    public function sendExternalFile(string $number, string $filePath, ?string $caption = null, ?string $session = null): array
    {
        $multipart = [
            ['name' => 'number', 'contents' => $number],
            ['name' => 'file', 'contents' => fopen($filePath, 'rb'), 'filename' => basename($filePath)],
        ];

        if ($caption !== null && $caption !== '') {
            $multipart[] = ['name' => 'caption', 'contents' => $caption];
        }

        if ($session) {
            $multipart[] = ['name' => 'session', 'contents' => $session];
        }

        return $this->request('POST', '/api/external/send-file', [
            'headers' => $this->headers(['Content-Type' => 'multipart/form-data']),
            'multipart' => $multipart,
        ]);
    }

    public function getStatus(?string $session = null): array
    {
        $query = $session ? ['session' => $session] : [];

        return $this->request('GET', '/api/status', [
            'query' => $query,
            'headers' => $this->headers(),
        ]);
    }

    public function getHistory(int $limit = 100): array
    {
        return $this->request('GET', '/api/history', [
            'query' => ['limit' => $limit],
            'headers' => $this->headers(),
        ]);
    }
}
