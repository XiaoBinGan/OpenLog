from pydantic import BaseModel, Field
from typing import Optional, List, Literal
from datetime import datetime

# Document schemas
class DocumentBase(BaseModel):
    name: str

class DocumentCreate(DocumentBase):
    pass

class IndexNode(BaseModel):
    id: str
    title: str
    page_start: int
    page_end: int
    level: int
    children: List["IndexNode"] = []
    
    class Config:
        arbitrary_types_allowed = True

class DocumentResponse(BaseModel):
    id: str
    name: str
    file_type: str
    file_size: int
    page_count: int
    index_status: Literal["pending", "indexing", "ready", "error"]
    index_tree: Optional[IndexNode] = None
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True

class DocumentListResponse(BaseModel):
    documents: List[DocumentResponse]
    total: int

# Conversation schemas
class MessageResponse(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    references: Optional[List[dict]] = None
    created_at: datetime
    
    class Config:
        from_attributes = True

class ConversationResponse(BaseModel):
    id: str
    title: str
    document_id: Optional[str] = None
    messages: List[MessageResponse] = []
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True

class ConversationListResponse(BaseModel):
    conversations: List[ConversationResponse]
    total: int

# Chat schemas
class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[str] = None
    document_id: Optional[str] = None
    stream: bool = True

class ChatResponse(BaseModel):
    conversation_id: str
    message: MessageResponse

# Index schemas
class IndexStatusResponse(BaseModel):
    document_id: str
    status: Literal["pending", "indexing", "ready", "error"]
    progress: Optional[float] = None
    error_message: Optional[str] = None

IndexNode.model_rebuild()
