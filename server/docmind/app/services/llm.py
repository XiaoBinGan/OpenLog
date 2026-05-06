import os
import re
from app.core.config import settings


class ThinkingStreamFilter:
    """流式思维过滤器 — 同时支持 XML 标签和纯文本 Qwen3 格式"""
    def __init__(self):
        self.in_thinking = False
        self.buffer = ""

    def feed(self, text: str) -> str:
        if not text:
            return ""
        self.buffer += text
        result = ""

        while self.buffer:
            if not self.in_thinking:
                # 找开始标记：XML <think...> 或文本 "Here's a thinking..."
                xml_start = self.buffer.find('<think')
                text_start = self.buffer.find("Here's a thinking")
                entity_start = self.buffer.find('&lt;think')

                # 取最近的开始位置
                candidates = [(xml_start, 'xml'), (text_start, 'text'), (entity_start, 'entity')]
                candidates = [(p, m) for p, m in candidates if p != -1]
                if not candidates:
                    # 还没找到开始，整个 buffer 留着等下一块
                    return ""
                start_pos, mode = min(candidates, key=lambda x: x[0])

                # 输出开始标记之前的内容
                result += self.buffer[:start_pos]
                self.buffer = self.buffer[start_pos:]
                self.in_thinking = True
                continue

            # 在思维块内，找结束标记
            xml_end = self.buffer.find('')
            text_end = self.buffer.find('')
            entity_end = self.buffer.find('&lt;/think&gt;')

            candidates = [(xml_end, 8), (text_end, 8), (entity_end, 13)]
            candidates = [(p, l) for p, l in candidates if p != -1]
            if not candidates:
                # 没找到结束，保留 buffer 等下一块
                return result

            end_pos, end_len = min(candidates, key=lambda x: x[0])
            # 结束标记之后的内容才是真正的回答
            after = self.buffer[end_pos + end_len:]
            result += after
            self.buffer = ""
            self.in_thinking = False
            return result

        return result

    def flush(self) -> str:
        """处理残留 buffer（通常不会有，Qwen3 总是在结束标记后停止）"""
        out = ""
        if self.in_thinking and self.buffer:
            # 尝试提取最后一行有意义的内容
            lines = self.buffer.split('\n')
            last = ""
            for line in reversed(lines):
                stripped = line.strip()
                if stripped and len(stripped) < 100 and any('\u4e00' <= c <= '\u9fff' or c.isalnum() for c in stripped):
                    last = stripped
                    break
            out = last
        self.buffer = ""
        self.in_thinking = False
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