FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    QUIZ_STATS_FILE=/stats/stats.json

WORKDIR /app

COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ server/
COPY data/leben-in-deutschland-pool.json data/i18n-content.json data/
COPY static/ static/

RUN useradd --system --no-create-home quiz \
    && mkdir /stats \
    && chown quiz: /stats
USER quiz

EXPOSE 8300

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8300/healthz', timeout=2)"

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8300"]
