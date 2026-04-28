from fastapi import APIRouter
import httpx

router = APIRouter(prefix="/api", tags=["models"])


@router.get("/models")
async def list_models():
    """List available LLM models based on provider configuration."""
    from app.core.config import settings
    from app.services.llm import llm_service
    
    provider = settings.LLM_PROVIDER
    
    # For Ollama/Local, fetch from the actual server
    if provider in ("local", "ollama"):
        try:
            async with httpx.AsyncClient() as client:
                # Ollama API - strip /v1 suffix if present to hit native endpoint
                base_url = settings.LOCAL_MODEL_URL.rstrip("/")
                if base_url.endswith("/v1"):
                    base_url = base_url[:-3]
                resp = await client.get(f"{base_url}/api/tags", timeout=5.0)
                if resp.status_code == 200:
                    data = resp.json()
                    models = [m["name"] for m in data.get("models", [])]
                    return {
                        "provider": provider,
                        "models": models,
                        "base_url": settings.LOCAL_MODEL_URL
                    }
        except Exception as e:
            return {
                "provider": provider,
                "error": f"Failed to connect to Ollama: {str(e)}",
                "base_url": settings.LOCAL_MODEL_URL
            }
    
    # For OpenAI/Anthropic, return configured models
    if provider == "openai":
        return {
            "provider": provider,
            "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
            "current": settings.OPENAI_MODEL
        }
    elif provider == "anthropic":
        return {
            "provider": provider,
            "models": ["claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-3-haiku-20240307"],
            "current": settings.ANTHROPIC_MODEL
        }
    
    return {"provider": provider, "models": []}
