from fastapi import FastAPI

app = FastAPI(title="subtitle-translator mock backend")


@app.get("/health")
def health():
    return {"status": "ok", "models_loaded": ["mock"], "languages_count": 3}


@app.get("/languages")
def languages():
    return {
        "mode": "any-to-any",
        "languages": [
            {"code": "en", "name": "English"},
            {"code": "fr", "name": "French"},
            {"code": "de", "name": "German"},
        ],
    }
