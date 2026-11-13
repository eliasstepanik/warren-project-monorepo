# Link shortener

A small link shortener using only Node's built-in `http` module (Node 22, no dependencies).
Links are persisted to a JSON file (written to a temp file, then renamed).

## Run

```sh
cd sandbox-apps/shortener
node server.js        # or: npm start
```

Listens on `http://127.0.0.1:3000` by default.

## Test

```sh
cd sandbox-apps/shortener
node --test           # or: npm test
```

## Configuration

| Variable              | Default          | Meaning                          |
| --------------------- | ---------------- | -------------------------------- |
| `PORT`                | `3000`           | TCP port                         |
| `HOST`                | `127.0.0.1`      | Bind address                     |
| `SHORTENER_DATA_FILE` | `data/links.json`| Path of the JSON data file       |

`createServer({ dataFile })` also accepts the data file path programmatically.
The data file is git-ignored.

- The default data path is relative to `server.js`; a relative `SHORTENER_DATA_FILE`
  is resolved against the current working directory.
- The data file must not be shared between processes (each process keeps the links in
  memory and rewrites the whole file, so concurrent writers would lose each other's data).

## API

### Create a link — `POST /api/links`

```sh
curl -i -X POST http://127.0.0.1:3000/api/links \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/some/long/path"}'
# 201 {"code":"aB3dE9","short":"/aB3dE9"}
```

Errors return `400` with `{"error": "..."}` (invalid JSON, missing or non-string `url`,
unparseable URL, protocol other than `http:`/`https:`); bodies over 8 KB return `413`
(checked up front from `Content-Length` when present).

Stored URLs are normalized by the WHATWG URL parser (`new URL(url).href`): hosts are
punycoded, non-ASCII path characters are percent-encoded, surrounding whitespace and
embedded tabs/newlines are removed. Stats and the `Location` header return the normalized form.

```sh
curl -i -X POST http://127.0.0.1:3000/api/links \
  -H 'Content-Type: application/json' \
  -d '{"url": "ftp://example.com/file"}'
# 400 {"error":"url protocol must be http: or https:"}
```

### Follow a link — `GET /:code`

```sh
curl -i http://127.0.0.1:3000/aB3dE9
# 302 Location: https://example.com/some/long/path   (hit count +1)
```

Unknown code: `404`.

### Stats — `GET /api/links/:code/stats`

```sh
curl http://127.0.0.1:3000/api/links/aB3dE9/stats
# {"url":"https://example.com/some/long/path","created_at":"2025-01-01T00:00:00.000Z","hits":1}
```

Unknown code: `404`. Other methods on known routes return `405`; unknown routes return `404`.
