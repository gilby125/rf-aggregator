FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bridge .

FROM alpine:3.20
RUN adduser -D -u 10001 bridge && mkdir -p /dynamic/telegraf.d && chown -R bridge /dynamic
# /dynamic ownership seeds the shared named volume on first use (docker copies from the image)
USER bridge
COPY --from=build /bridge /usr/local/bin/bridge
ENTRYPOINT ["bridge"]
