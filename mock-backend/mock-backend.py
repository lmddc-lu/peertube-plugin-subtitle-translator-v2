from fastapi import FastAPI

app = FastAPI(title="subtitle-translator mock backend")


@app.get("/health")
def health():
    return {"status": "ok", "models_loaded": ["mock"], "languages_count": 3}


@app.get("/languages")
def languages():
    return [
        {"code": "en", "name": "English", "supports_source": True, "supports_target": True},
        {"code": "fr", "name": "French", "supports_source": True, "supports_target": True},
        {"code": "de", "name": "German", "supports_source": True, "supports_target": True},
    ]
