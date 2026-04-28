import os
import re
from app.core.config import settings

class ThinkingStreamFilter:
    """流式思维过滤器"""
    def __init__(self):
        self.skip_mode = False
        self.buffer = ""

    def feed(self, text):
        if not text:
            return ""
        self.buffer += text
        result = ""
        while self.buffer:
            # XML: 开始标签
            think = '调查'
            end_tag = '结束'
            if think in self.buffer:
                parts = self.buffer.split(think, 1)
                result += parts[0]
                self.buffer = parts[1] if len(parts) > 1 else ''
                self.skip_mode = True
                continue
            if self.skip_mode:
                if end_tag in self.buffer:
                    parts = self.buffer.split(end_tag, 1)
                    self.buffer = parts[1] or ''
                    self.skip_mode = False
                elif "Here's a thinking process" in self.buffer:
                    self.buffer = self.buffer.split("Here's a thinking process", 1)[1]
                    continue
                else:
                    break
            else:
                break
        return result

    def flush(self):
        out = ""
        if self.skip_mode and self.buffer:
            end_tag = '结束'
            if end_tag in self.buffer:
                out = self.buffer.split(end_tag, 1)[1]
            self.buffer = ""
            self.skip_mode = False
        return out


class LLMService:
    def __init__(self):
        self._client = None

    @property
    def client(self):
        if self._client is None:
            if settings.LLM_PROVIDER == "openai":
                from openai import AsyncOpenAI
                self._client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
            elif settings.LLM_PROVIDER == "anthropic":
                from anthropic import AsyncAnthropic
                self._client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
            elif settings.LLM_PROVIDER in ("local", "ollama"):
                from openai import AsyncOpenAI
                self._client = AsyncOpenAI(
                    base_url=settings.LOCAL_MODEL_URL,
                    api_key=settings.OPENAI_API_KEY or "ollama"
                )
        return self._client

    def get_model(self):
        if settings.LLM_PROVIDER == "openai":
            return settings.OPENAI_MODEL
        elif settings.LLM_PROVIDER == "anthropic":
            return settings.ANTHROPIC_MODEL
        else:
            return settings.LOCAL_MODEL_NAME

    async def generate(self, system_prompt, user_prompt, stream=True):
        model = self.get_model()
        thinking_filter = ThinkingStreamFilter()

        if settings.LLM_PROVIDER == "anthropic":
            async with self.client.messages.stream(
                model=settings.ANTHROPIC_MODEL,
                max_tokens=4096,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}]
            ) as stream_response:
                async for text in stream_response.text_stream:
                    content = thinking_filter.feed(text)
                    if content:
                        yield content
            remaining = thinking_filter.flush()
            if remaining:
                yield remaining
        else:
            response = await self.client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                stream=stream,
                temperature=0.7,
                max_tokens=4096
            )
            if stream:
                async for chunk in response:
                    if chunk.choices[0].delta.content:
                        content = thinking_filter.feed(chunk.choices[0].delta.content)
                        if content:
                            yield content
                remaining = thinking_filter.flush()
                if remaining:
                    yield remaining
            else:
                yield response.choices[0].message.content


llm_service = LLMService()
