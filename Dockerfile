FROM python:3.12-slim

# ffmpeg is required to merge video+audio and to extract MP3
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py index.html README.html ./
ENV PORT=8000
EXPOSE 8000
CMD ["python", "app.py"]
