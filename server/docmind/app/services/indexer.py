import uuid
import json
from typing import List, Optional
from app.services.parser import document_parser
from app.services.llm import llm_service
from app.core.config import settings

class IndexNode:
    def __init__(
        self, 
        title: str, 
        page_start: int, 
        page_end: int, 
        level: int,
        content_summary: str = "",
        raw_content: str = ""
    ):
        self.id = str(uuid.uuid4())[:8]
        self.title = title
        self.page_start = page_start
        self.page_end = page_end
        self.level = level
        self.content_summary = content_summary
        self.raw_content = raw_content
        self.children: List[IndexNode] = []
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "level": self.level,
            "content_summary": self.content_summary,
            "raw_content": self.raw_content,
            "children": [child.to_dict() for child in self.children]
        }
    
    @staticmethod
    def from_dict(data: dict) -> "IndexNode":
        node = IndexNode(
            title=data["title"],
            page_start=data["page_start"],
            page_end=data["page_end"],
            level=data["level"],
            content_summary=data.get("content_summary", ""),
            raw_content=data.get("raw_content", "")
        )
        node.id = data.get("id", str(uuid.uuid4())[:8])
        if "children" in data:
            node.children = [IndexNode.from_dict(child) for child in data["children"]]
        return node
    
    def get_all_nodes(self) -> List["IndexNode"]:
        """Get all nodes including children recursively."""
        nodes = [self]
        for child in self.children:
            nodes.extend(child.get_all_nodes())
        return nodes


class PageIndexer:
    """
    PageIndex 索引构建器
    
    核心思路：
    1. 解析文档页面
    2. 对每页/每个内容块生成摘要
    3. 使用 LLM 分析内容结构，构建 ToC 树
    4. 存储树结构供后续检索使用
    """
    
    def __init__(self):
        self.max_depth = settings.MAX_TREE_DEPTH
        self.max_leaves = settings.MAX_LEAF_NODES
    
    async def build_index(self, file_path: str) -> dict:
        """Build a PageIndex tree from a document."""
        # Step 1: Parse the document
        parsed = await document_parser.parse(file_path)
        if not parsed.get("success"):
            return {"success": False, "error": parsed.get("error")}
        
        pages = parsed["pages"]
        title = parsed.get("title", "Untitled")
        
        # Step 2: Generate page summaries
        page_summaries = await self._generate_page_summaries(pages)
        
        # Step 3: Build the index tree
        index_tree = await self._build_tree(title, pages, page_summaries)
        
        return {
            "success": True,
            "page_count": len(pages),
            "index_tree": index_tree.to_dict() if index_tree else None,
            "title": title
        }
    
    async def _generate_page_summaries(self, pages: List[dict]) -> List[dict]:
        """Generate summaries for each page using LLM."""
        summaries = []
        
        for i, page in enumerate(pages):
            content = page["content"]
            if not content or len(content.strip()) < 50:
                summaries.append({
                    "page_number": page["page_number"],
                    "summary": "",
                    "key_topics": []
                })
                continue
            
            # Truncate very long content
            truncated = content[:4000] if len(content) > 4000 else content
            
            prompt = f"""Analyze this document page and provide a brief summary. Pay special attention to tables, classifications, and structured content.

PAGE CONTENT:
{truncated}

If this page contains tables or classifications, include them in your summary. Respond with JSON only:
{{
    "summary": "2-3 sentence summary including any tables/classifications mentioned",
    "key_topics": ["topic1", "topic2", "topic3"],
    "has_tables": true/false,
    "tables_description": "Brief description of any tables or classifications on this page"
}}"""
            
            try:
                result = await llm_service.generate_structure(prompt)
                # Parse JSON from result
                import re
                json_match = re.search(r'\{.*\}', result, re.DOTALL)
                if json_match:
                    data = json.loads(json_match.group())
                    summaries.append({
                        "page_number": page["page_number"],
                        "summary": data.get("summary", ""),
                        "key_topics": data.get("key_topics", [])
                    })
                else:
                    summaries.append({
                        "page_number": page["page_number"],
                        "summary": truncated[:200] + "...",
                        "key_topics": []
                    })
            except Exception as e:
                summaries.append({
                    "page_number": page["page_number"],
                    "summary": truncated[:200] + "...",
                    "key_topics": []
                })
        
        return summaries
    
    async def _build_tree(self, title: str, pages: List[dict], summaries: List[dict]) -> IndexNode:
        """Build the hierarchical index tree using LLM analysis."""
        
        # Create a summary of all summaries for LLM analysis
        summary_text = "\n".join([
            f"Page {s['page_number']}: {s['summary']} (Topics: {', '.join(s['key_topics'])})"
            for s in summaries if s["summary"]
        ])
        
        if not summary_text:
            # Fallback: create a simple single-level tree
            root = IndexNode(title=title, page_start=1, page_end=len(pages), level=0)
            for i, page in enumerate(pages):
                if page["content"]:
                    child = IndexNode(
                        title=f"Page {page['page_number']}",
                        page_start=page["page_number"],
                        page_end=page["page_number"],
                        level=1,
                        raw_content=page["content"][:500]
                    )
                    root.children.append(child)
            return root
        
        # Use LLM to analyze structure and build ToC
        prompt = f"""Analyze this document and build a hierarchical table of contents structure.

DOCUMENT TITLE: {title}
TOTAL PAGES: {len(pages)}

PAGE SUMMARIES:
{summary_text}

Based on the page summaries, create a logical document structure. Identify:
1. Main sections (top level, level 1)
2. Subsections (level 2)
3. The page range each section covers

Return a JSON tree structure. Each node should have:
- title: section name
- level: 0 for root, 1 for main sections, 2 for subsections
- page_start: first page number
- page_end: last page number

Respond with JSON only:
{{
    "sections": [
        {{
            "title": "Section Name",
            "level": 1,
            "page_start": 1,
            "page_end": 5,
            "subsections": [
                {{"title": "Subsection", "level": 2, "page_start": 1, "page_end": 3}}
            ]
        }}
    ]
}}"""
        
        try:
            result = await llm_service.generate_structure(prompt)
            import re
            json_match = re.search(r'\{.*\}', result, re.DOTALL)
            
            if json_match:
                data = json.loads(json_match.group())
                
                # Build the tree from LLM output
                root = IndexNode(title=title, page_start=1, page_end=len(pages), level=0)
                
                for section in data.get("sections", []):
                    section_node = IndexNode(
                        title=section["title"],
                        page_start=section.get("page_start", 1),
                        page_end=section.get("page_end", len(pages)),
                        level=section.get("level", 1)
                    )
                    
                    for subsection in section.get("subsections", []):
                        sub_node = IndexNode(
                            title=subsection["title"],
                            page_start=subsection.get("page_start", section["page_start"]),
                            page_end=subsection.get("page_end", section["page_end"]),
                            level=subsection.get("level", 2)
                        )
                        section_node.children.append(sub_node)
                    
                    root.children.append(section_node)
                
                return root
            else:
                raise ValueError("Failed to parse LLM response")
                
        except Exception as e:
            # Fallback: create simple structure
            root = IndexNode(title=title, page_start=1, page_end=len(pages), level=0)
            for i, page in enumerate(pages):
                if page["content"]:
                    child = IndexNode(
                        title=f"Page {page['page_number']}",
                        page_start=page["page_number"],
                        page_end=page["page_number"],
                        level=1,
                        raw_content=page["content"][:1000]
                    )
                    root.children.append(child)
            return root


class PageRetriever:
    """
    PageIndex 检索器
    
    核心思路：
    1. 接收用户问题
    2. 让 LLM "思考"需要检索什么，遍历索引树
    3. 选择最相关的节点
    4. 返回上下文片段
    """
    
    def __init__(self, index_tree: Optional[dict] = None, pages: Optional[List[dict]] = None):
        self.index_tree = IndexNode.from_dict(index_tree) if index_tree else None
        self.pages = pages or []
        self._page_map = {p["page_number"]: p for p in self.pages}
    
    def set_index(self, index_tree: dict, pages: List[dict]):
        self.index_tree = IndexNode.from_dict(index_tree) if index_tree else None
        self.pages = pages
        self._page_map = {p["page_number"]: p for p in pages}
    
    async def retrieve(self, query: str, top_k: int = 5) -> List[dict]:
        """
        Retrieve relevant content based on query using reasoning-based retrieval.
        
        Instead of vector similarity, we use LLM to:
        1. Analyze what information is needed
        2. Traverse the index tree to find relevant sections
        3. Extract content from relevant pages
        """
        if not self.index_tree:
            return []
        
        # Build context for LLM to reason about
        tree_repr = self._tree_to_text(self.index_tree)
        
        prompt = f"""You are analyzing a document index to find relevant sections for answering a user question.

USER QUESTION: {query}

DOCUMENT INDEX STRUCTURE:
{tree_repr}

Analyze which sections are most relevant to answer the user's question.
Consider:
1. What information does the user need?
2. Which sections would contain this information?
3. What's the logical order of information?

Return a JSON list of relevant page ranges, ordered by relevance:
[
    {{"page_start": 1, "page_end": 3, "reason": "Contains introduction and overview"}},
    {{"page_start": 5, "page_end": 7, "reason": "Detailed technical specifications"}}
]

Respond with JSON only, no other text."""

        try:
            result = await llm_service.generate_structure(prompt)
            import re
            json_match = re.search(r'\[.*\]', result, re.DOTALL)
            
            if json_match:
                ranges = json.loads(json_match.group())
                
                results = []
                for r in ranges[:top_k]:
                    ps = r.get("page_start", 1)
                    pe = r.get("page_end", ps)
                    reason = r.get("reason", "")
                    
                    for pn in range(ps, pe + 1):
                        if pn in self._page_map:
                            page = self._page_map[pn]
                            if page["content"]:
                                results.append({
                                    "page": pn,
                                    "content": page["content"],
                                    "reason": reason,
                                    "char_count": page["char_count"]
                                })
                
                return results
            else:
                return self._fallback_retrieve(query, top_k)
                
        except Exception:
            return self._fallback_retrieve(query, top_k)
    
    def _fallback_retrieve(self, query: str, top_k: int) -> List[dict]:
        """Fallback: return content from all pages."""
        results = []
        for page in self.pages[:top_k]:
            if page["content"]:
                results.append({
                    "page": page["page_number"],
                    "content": page["content"],
                    "reason": "Content page",
                    "char_count": page["char_count"]
                })
        return results
    
    def _tree_to_text(self, node: IndexNode, indent: int = 0) -> str:
        """Convert tree to readable text representation."""
        prefix = "  " * indent
        text = f"{prefix}[L{node.level}] {node.title} (pages {node.page_start}-{node.page_end})\n"
        for child in node.children:
            text += self._tree_to_text(child, indent + 1)
        return text


page_indexer = PageIndexer()
