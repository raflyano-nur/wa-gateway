const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");

class WhatsappGatewayClient {
  constructor({ baseUrl, apiKey = null, timeout = 30000 } = {}) {
    if (!baseUrl) {
      throw new Error("baseUrl is required");
    }

    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout,
      validateStatus: () => true,
    });
  }

  _headers(extra = {}) {
    const headers = { ...extra };
    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
    }
    return headers;
  }

  async sendText({ number, message, session = null }) {
    const payload = { number, message };
    if (session) payload.session = session;

    const response = await this.client.post("/api/send", payload, {
      headers: this._headers(),
    });

    return response.data;
  }

  async sendFile({ number, filePath, caption = "", session = null }) {
    const formData = new FormData();
    formData.append("number", number);
    formData.append("file", fs.createReadStream(filePath));

    if (caption) {
      formData.append("caption", caption);
    }

    if (session) {
      formData.append("session", session);
    }

    const response = await this.client.post("/api/send-file", formData, {
      headers: this._headers(formData.getHeaders()),
    });

    return response.data;
  }

  async sendExternalText({ number, message, session = null }) {
    const payload = { number, message };
    if (session) payload.session = session;

    const response = await this.client.post("/api/external/send", payload, {
      headers: this._headers(),
    });

    return response.data;
  }

  async getStatus(session = null) {
    const response = await this.client.get("/api/status", {
      params: session ? { session } : {},
      headers: this._headers(),
    });

    return response.data;
  }

  async getHistory(limit = 100) {
    const response = await this.client.get("/api/history", {
      params: { limit },
      headers: this._headers(),
    });

    return response.data;
  }
}

module.exports = { WhatsappGatewayClient };
