# One image per Python service: docker build --build-arg SERVICE=verifier -f infra/docker/python.Dockerfile .
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ARG SERVICE
ENV SERVICE=${SERVICE}
WORKDIR /repo
COPY . .
# uv installs everything; pip and the packages it vendors are not shipped (D134).
RUN uv sync --frozen --no-dev --package anr-${SERVICE} && python -m pip uninstall -y pip
CMD ["sh", "-c", "uv run --frozen --no-dev uvicorn anr_${SERVICE}.app:app --host 0.0.0.0 --port 8000"]
