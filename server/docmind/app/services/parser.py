import os
import asyncio
import tempfile
from typing import List, Optional
from pathlib import Path

# Marker 模型缓存路径
MARKER_CACHE_DIR = os.path.expanduser("~/Library/Caches/datalab")


class DocumentParser:
    """Parse various document formats and extract text content."""
    
    SUPPORTED_TYPES = {".pdf", ".docx", ".txt", ".md"}
    
    # Marker 是否可用（运行时检测）
    _marker_available = None
    _marker_models_loaded = False
    
    @staticmethod
    def get_supported_types() -> List[str]:
        return list(DocumentParser.SUPPORTED_TYPES)
    
    @staticmethod
    def is_supported(file_path: str) -> bool:
        ext = Path(file_path).suffix.lower()
        return ext in DocumentParser.SUPPORTED_TYPES
    
    @staticmethod
    async def parse(file_path: str) -> dict:
        """Parse a document and return its content structure."""
        ext = Path(file_path).suffix.lower()
        
        if ext == ".pdf":
            return await DocumentParser._parse_pdf(file_path)
        elif ext == ".docx":
            return await DocumentParser._parse_docx(file_path)
        elif ext in {".txt", ".md"}:
            return await DocumentParser._parse_text(file_path)
        else:
            raise ValueError(f"Unsupported file type: {ext}")
    
    @staticmethod
    async def _parse_pdf(file_path: str) -> dict:
        """Parse PDF file using Marker (preferred) or PyPDF2 (fallback)."""
        
        # 尝试用 Marker 解析
        marker_result = await DocumentParser._parse_pdf_marker(file_path)
        if marker_result:
            return marker_result
        
        # 回退到 PyPDF2
        return await DocumentParser._parse_pdf_pypdf2(file_path)
    
    @staticmethod
    async def _parse_pdf_marker(file_path: str) -> Optional[dict]:
        """Parse PDF using Marker for high-quality Markdown output."""
        
        # 检测 Marker 是否可用
        if DocumentParser._marker_available is None:
            await DocumentParser._check_marker_available()
        
        if not DocumentParser._marker_available:
            return None
        
        try:
            # 延迟导入和加载模型
            if not DocumentParser._marker_models_loaded:
                from marker.models import create_model_dict
                from marker.converters.pdf import PdfConverter
                from marker.renderers.markdown import MarkdownRenderer
                
                # 设置缓存路径
                os.environ.setdefault("HF_HOME", MARKER_CACHE_DIR)
                
                print("Loading Marker models...")
                models = create_model_dict()
                DocumentParser._marker_models_loaded = True
                print(f"Marker models loaded: {list(models.keys())}")
            
            from marker.converters.pdf import PdfConverter
            from marker.renderers.markdown import MarkdownRenderer
            from marker.models import create_model_dict
            
            # 创建 converter
            converter = PdfConverter(
                create_model_dict(),
                MarkdownRenderer()
            )
            
            # 转换 PDF
            print(f"Converting PDF with Marker: {file_path}")
            rendered = converter(file_path)
            
            # rendered.markdown 包含完整的 Markdown 内容
            markdown_text = rendered.markdown
            
            if not markdown_text or len(markdown_text.strip()) < 50:
                return None
            
            # 按页拆分 Markdown（Marker 输出的是完整文档）
            # 由于 Marker 不返回页码，我们按内容长度分块
            pages = DocumentParser._split_markdown_to_pages(markdown_text)
            
            return {
                "success": True,
                "page_count": len(pages),
                "pages": pages,
                "title": Path(file_path).stem,
                "parser": "marker",
                "markdown": markdown_text  # 保留完整 Markdown
            }
            
        except Exception as e:
            print(f"Marker parsing failed: {e}")
            DocumentParser._marker_available = False
            return None
    
    @staticmethod
    def _split_markdown_to_pages(markdown_text: str, chars_per_page: int = 4000) -> List[dict]:
        """Split markdown text into pages while preserving structure."""
        
        # 按标题或段落分割
        lines = markdown_text.split('\n')
        pages = []
        current_page_content = []
        current_chars = 0
        page_num = 1
        
        for line in lines:
            line_len = len(line)
            
            # 如果单行超长，强制换页
            if line_len > chars_per_page:
                if current_page_content:
                    pages.append({
                        "page_number": page_num,
                        "content": '\n'.join(current_page_content),
                        "char_count": current_chars
                    })
                    page_num += 1
                    current_page_content = []
                    current_chars = 0
            
            current_page_content.append(line)
            current_chars += line_len + 1  # +1 for newline
            
            # 达到阈值换页
            if current_chars >= chars_per_page:
                # 避免在列表或代码块中间断开
                if (line.strip().startswith('-') or 
                    line.strip().startswith('```') or
                    line.strip().endswith('```')):
                    continue  # 继续积累
                
                pages.append({
                    "page_number": page_num,
                    "content": '\n'.join(current_page_content),
                    "char_count": current_chars
                })
                page_num += 1
                current_page_content = []
                current_chars = 0
        
        # 最后一部分
        if current_page_content:
            pages.append({
                "page_number": page_num,
                "content": '\n'.join(current_page_content),
                "char_count": current_chars
            })
        
        # 确保至少有1页
        if not pages:
            pages.append({
                "page_number": 1,
                "content": markdown_text,
                "char_count": len(markdown_text)
            })
        
        return pages
    
    @staticmethod
    async def _check_marker_available() -> bool:
        """Check if Marker is available and can be loaded."""
        try:
            import marker
            DocumentParser._marker_available = True
            return True
        except ImportError:
            DocumentParser._marker_available = False
            return False
    
    @staticmethod
    async def _parse_pdf_pypdf2(file_path: str) -> dict:
        """Parse PDF file using PyPDF2 (fallback)."""
        try:
            from PyPDF2 import PdfReader
            
            reader = PdfReader(file_path)
            pages = []
            
            for i, page in enumerate(reader.pages):
                text = page.extract_text()
                pages.append({
                    "page_number": i + 1,
                    "content": text.strip() if text else "",
                    "char_count": len(text) if text else 0
                })
            
            return {
                "success": True,
                "page_count": len(pages),
                "pages": pages,
                "title": Path(file_path).stem,
                "parser": "pypdf2"
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    @staticmethod
    async def _parse_docx(file_path: str) -> dict:
        """Parse DOCX file using python-docx."""
        try:
            from docx import Document
            
            doc = Document(file_path)
            pages = []
            current_page = {"page_number": 1, "content": "", "char_count": 0}
            page_chars = 0
            page_threshold = 3000
            
            for para in doc.paragraphs:
                text = para.text.strip()
                if not text:
                    continue
                
                current_page["content"] += text + "\n"
                page_chars += len(text)
                
                if page_chars >= page_threshold:
                    pages.append(current_page)
                    current_page = {"page_number": len(pages) + 1, "content": "", "char_count": 0}
                    page_chars = 0
            
            if current_page["content"]:
                current_page["char_count"] = page_chars
                pages.append(current_page)
            
            return {
                "success": True,
                "page_count": len(pages),
                "pages": pages,
                "title": Path(file_path).stem
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }
    
    @staticmethod
    async def _parse_text(file_path: str) -> dict:
        """Parse plain text or markdown file."""
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            
            # Split into chunks for "pages"
            chunk_size = 3000
            pages = []
            current_page = {"page_number": 1, "content": "", "char_count": 0}
            
            for i, char in enumerate(content):
                current_page["content"] += char
                current_page["char_count"] += 1
                
                if current_page["char_count"] >= chunk_size:
                    pages.append(current_page)
                    current_page = {"page_number": len(pages) + 1, "content": "", "char_count": 0}
            
            if current_page["content"]:
                pages.append(current_page)
            
            return {
                "success": True,
                "page_count": len(pages),
                "pages": pages,
                "title": Path(file_path).stem
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }


document_parser = DocumentParser()
