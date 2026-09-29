swagger: "2.0"
info:
  title: DLB Trust Transfer API
  description: >-
    Single transfer facade for the DeAndrea Lavar Barkley Family Trust
    (private Ohio family trust company). Submits distributions, disbursements,
    vendor payouts and trustee expenses to the Enterprise ODFI OS maker/checker
    flow; USA / USD only. The gateway verifies the caller, applies quotas and
    forwards to Cloud Run through IAP with its own service-account identity.
  version: ${api_version}
schemes:
  - https
produces:
  - application/json
consumes:
  - application/json

x-google-backend:
  address: ${backend_address}
  jwt_audience: ${backend_jwt_audience}
  path_translation: APPEND_PATH_TO_ADDRESS
  protocol: h2
  deadline: 60.0

x-google-management:
  metrics:
    - name: transfer-writes
      displayName: Transfer writes
      valueType: INT64
      metricKind: DELTA
    - name: transfer-reads
      displayName: Transfer reads
      valueType: INT64
      metricKind: DELTA
  quota:
    limits:
      - name: transfer-writes-per-minute
        metric: transfer-writes
        unit: "1/min/{project}"
        values:
          STANDARD: ${write_quota_per_minute}
      - name: transfer-reads-per-minute
        metric: transfer-reads
        unit: "1/min/{project}"
        values:
          STANDARD: ${read_quota_per_minute}

securityDefinitions:
  google_id_token:
    authorizationUrl: ""
    flow: implicit
    type: oauth2
    x-google-issuer: https://accounts.google.com
    x-google-jwks_uri: https://www.googleapis.com/oauth2/v3/certs
    x-google-audiences: ${id_token_audience}
  api_key:
    type: apiKey
    name: x-api-key
    in: header

paths:
  /v1/status:
    get:
      operationId: transferStatus
      summary: Facade status (gateway, delegate engine, policy)
      security:
        - google_id_token: []
        - api_key: []
      x-google-quota:
        metricCosts:
          transfer-reads: 1
      responses:
        "200":
          description: OK
  /v1/rails:
    get:
      operationId: transferRails
      summary: Verified Clearing Agent networks grouped by rail
      security:
        - google_id_token: []
        - api_key: []
      x-google-quota:
        metricCosts:
          transfer-reads: 1
      responses:
        "200":
          description: OK
  /v1/transfers:
    get:
      operationId: listTransfers
      summary: Recent transfers (batches)
      security:
        - google_id_token: []
        - api_key: []
      x-google-quota:
        metricCosts:
          transfer-reads: 1
      responses:
        "200":
          description: OK
    post:
      operationId: createTransfer
      summary: Maker submits approved + screened items (planned batch; nothing moves)
      security:
        - google_id_token: []
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          type: string
        - name: body
          in: body
          required: true
          schema:
            type: object
      x-google-quota:
        metricCosts:
          transfer-writes: 1
      responses:
        "201":
          description: Created
        "200":
          description: Replayed
  /v1/transfers/{id}:
    get:
      operationId: getTransfer
      summary: One transfer with item summaries (last-4 only)
      security:
        - google_id_token: []
        - api_key: []
      parameters:
        - name: id
          in: path
          required: true
          type: string
      x-google-quota:
        metricCosts:
          transfer-reads: 1
      responses:
        "200":
          description: OK
  /v1/transfers/{id}/release:
    post:
      operationId: releaseTransfer
      summary: Distinct checker releases a planned transfer via Enterprise ODFI -> Clearing Agent
      security:
        - google_id_token: []
      parameters:
        - name: id
          in: path
          required: true
          type: string
        - name: Idempotency-Key
          in: header
          required: true
          type: string
      x-google-quota:
        metricCosts:
          transfer-writes: 1
      responses:
        "200":
          description: OK
  /v1/transfers/{id}/cancel:
    post:
      operationId: cancelTransfer
      summary: Cancel a planned transfer
      security:
        - google_id_token: []
      parameters:
        - name: id
          in: path
          required: true
          type: string
        - name: Idempotency-Key
          in: header
          required: true
          type: string
        - name: body
          in: body
          required: false
          schema:
            type: object
      x-google-quota:
        metricCosts:
          transfer-writes: 1
      responses:
        "200":
          description: OK
