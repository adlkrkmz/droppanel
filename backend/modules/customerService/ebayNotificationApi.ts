/**
 * Official Commerce Notification API v1:
 * GET/POST /commerce/notification/v1/destination
 * GET/POST /commerce/notification/v1/subscription
 * GET /commerce/notification/v1/topic and /topic/{topic_id}
 * GET /commerce/notification/v1/public_key/{public_key_id}
 */

export type NotificationTopic = {
  topicId: string
  scope: string | null
  status: string | null
  authorizationScopes: string[]
  schemaVersion: string | null
  description: string | null
}

export type NotificationDestination = {
  destinationId: string | null
  name: string | null
  status: string | null
  endpoint: string | null
}

export type NotificationSubscription = {
  subscriptionId: string | null
  topicId: string | null
  destinationId: string | null
  status: string | null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function idFromLocation(location: string | null, marker: string): string | null {
  if (!location) return null
  const idx = location.toLowerCase().lastIndexOf(marker)
  if (idx < 0) return asString(location.split("/").pop() ?? null)
  return asString(location.slice(idx + marker.length).split("?")[0] ?? "")
}

export class EbayNotificationApi {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string
  ) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    }
    if (json) h["Content-Type"] = "application/json"
    return h
  }

  private async request(method: string, path: string, body?: unknown): Promise<{
    status: number
    text: string
    location: string | null
    json: unknown
  }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return {
      status: res.status,
      text,
      location: res.headers.get("location"),
      json: text ? parseJson(text) : null,
    }
  }

  async getConfig(): Promise<{ alertEmail: string | null }> {
    const out = await this.request("GET", "/commerce/notification/v1/config")
    if (out.status === 404) return { alertEmail: null }
    if (out.status < 200 || out.status >= 300) {
      throw new Error(`GET /config failed: HTTP ${out.status} - ${out.text.slice(0, 400)}`)
    }
    const rec = asRecord(out.json) ?? {}
    return { alertEmail: asString(rec.alertEmail) }
  }

  async updateConfig(alertEmail: string): Promise<void> {
    const out = await this.request("PUT", "/commerce/notification/v1/config", { alertEmail })
    if (out.status !== 204 && (out.status < 200 || out.status >= 300)) {
      throw new Error(`PUT /config failed: HTTP ${out.status} - ${out.text.slice(0, 400)}`)
    }
  }

  async getTopic(topicId: string): Promise<NotificationTopic | null> {
    const id = topicId.trim()
    const out = await this.request("GET", `/commerce/notification/v1/topic/${encodeURIComponent(id)}`)
    if (out.status === 404) return null
    if (out.status < 200 || out.status >= 300) {
      throw new Error(`GET /topic/${id} failed: HTTP ${out.status} - ${out.text.slice(0, 400)}`)
    }
    const rec = asRecord(out.json) ?? {}
    const payloads = Array.isArray(rec.supportedPayloads) ? rec.supportedPayloads : []
    const first = asRecord(payloads[0])
    const scopes = Array.isArray(rec.authorizationScopes)
      ? rec.authorizationScopes.map(v => asString(v)).filter((v): v is string => !!v)
      : []
    return {
      topicId: asString(rec.topicId) || id,
      scope: asString(rec.scope),
      status: asString(rec.status),
      authorizationScopes: scopes,
      schemaVersion: asString(first?.schemaVersion),
      description: asString(rec.description),
    }
  }

  async getDestinations(): Promise<NotificationDestination[]> {
    const rows: NotificationDestination[] = []
    let token: string | null = null
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ limit: "50" })
      if (token) q.set("continuation_token", token)
      const out = await this.request("GET", `/commerce/notification/v1/destination?${q.toString()}`)
      if (out.status < 200 || out.status >= 300) {
        throw new Error(`GET /destination failed: HTTP ${out.status} - ${out.text.slice(0, 400)}`)
      }
      const rec = asRecord(out.json) ?? {}
      const list = Array.isArray(rec.destinations) ? rec.destinations : []
      for (const item of list) {
        const d = asRecord(item)
        if (!d) continue
        const delivery = asRecord(d.deliveryConfig)
        rows.push({
          destinationId: asString(d.destinationId),
          name: asString(d.name),
          status: asString(d.status),
          endpoint: asString(delivery?.endpoint),
        })
      }
      token = asString(rec.next) || asString(rec.continuationToken)
      if (!token) break
    }
    return rows
  }

  async createDestination(input: {
    name: string
    endpoint: string
    verificationToken: string
  }): Promise<string> {
    const out = await this.request("POST", "/commerce/notification/v1/destination", {
      name: input.name,
      status: "ENABLED",
      deliveryConfig: {
        endpoint: input.endpoint,
        verificationToken: input.verificationToken,
      },
    })
    if (out.status !== 201 && (out.status < 200 || out.status >= 300)) {
      throw new Error(`POST /destination failed: HTTP ${out.status} - ${out.text.slice(0, 400)}`)
    }
    const rec = asRecord(out.json)
    const id = asString(rec?.destinationId) || idFromLocation(out.location, "/destination/")
    if (!id) throw new Error("POST /destination: missing destinationId")
    return id
  }

  async getSubscriptions(): Promise<NotificationSubscription[]> {
    const rows: NotificationSubscription[] = []
    let token: string | null = null
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ limit: "50" })
      if (token) q.set("continuation_token", token)
      const out = await this.request("GET", `/commerce/notification/v1/subscription?${q.toString()}`)
      if (out.status < 200 || out.status >= 300) {
        throw new Error(`GET /subscription failed: HTTP ${out.status} - ${out.text.slice(0, 400)}`)
      }
      const rec = asRecord(out.json) ?? {}
      const list = Array.isArray(rec.subscriptions) ? rec.subscriptions : []
      for (const item of list) {
        const s = asRecord(item)
        if (!s) continue
        rows.push({
          subscriptionId: asString(s.subscriptionId),
          topicId: asString(s.topicId),
          destinationId: asString(s.destinationId),
          status: asString(s.status),
        })
      }
      token = asString(rec.next) || asString(rec.continuationToken)
      if (!token) break
    }
    return rows
  }

  async createSubscription(input: {
    topicId: string
    destinationId: string
    schemaVersion: string | null
  }): Promise<string> {
    const payload: Record<string, unknown> = {
      format: "JSON",
      deliveryProtocol: "HTTPS",
    }
    if (input.schemaVersion) payload.schemaVersion = input.schemaVersion
    const out = await this.request("POST", "/commerce/notification/v1/subscription", {
      topicId: input.topicId,
      destinationId: input.destinationId,
      status: "ENABLED",
      payload,
    })
    if (out.status === 409) {
      const existing = await this.getSubscriptions()
      const match = existing.find(s => s.topicId === input.topicId && s.subscriptionId)
      if (match?.subscriptionId) return match.subscriptionId
    }
    if (out.status !== 201 && (out.status < 200 || out.status >= 300)) {
      throw new Error(`POST /subscription failed: HTTP ${out.status} - ${out.text.slice(0, 400)}`)
    }
    const rec = asRecord(out.json)
    const id = asString(rec?.subscriptionId) || idFromLocation(out.location, "/subscription/")
    if (!id) throw new Error("POST /subscription: missing subscriptionId")
    return id
  }

  async testSubscription(subscriptionId: string): Promise<number> {
    const id = subscriptionId.trim()
    if (!id) throw new Error("subscriptionId is required")
    const out = await this.request("POST", `/commerce/notification/v1/subscription/${encodeURIComponent(id)}/test`)
    if (out.status !== 202 && (out.status < 200 || out.status >= 300)) {
      throw new Error(`POST /subscription/{id}/test failed: HTTP ${out.status} - ${out.text.slice(0, 400)}`)
    }
    return out.status
  }

  async getPublicKey(publicKeyId: string): Promise<{ algorithm: string | null; key: string | null }> {
    const id = publicKeyId.trim()
    const out = await this.request("GET", `/commerce/notification/v1/public_key/${encodeURIComponent(id)}`)
    if (out.status < 200 || out.status >= 300) {
      throw new Error(`GET /public_key failed: HTTP ${out.status} - ${out.text.slice(0, 400)}`)
    }
    const rec = asRecord(out.json) ?? {}
    return { algorithm: asString(rec.algorithm), key: asString(rec.key) }
  }
}
