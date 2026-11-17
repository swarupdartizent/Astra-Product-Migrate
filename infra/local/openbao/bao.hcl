ui            = true

storage "file" {
  path = "/openbao/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true # local only; Azure uses Key Vault over TLS
}

api_addr = "http://127.0.0.1:8200"
