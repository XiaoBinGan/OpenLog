package services

import (
	"strings"
)

// ThinkingStreamFilter filters <think>...</think> blocks from LLM streams
type ThinkingStreamFilter struct {
	buffer     string
	inside     bool
	enabled    bool
}

func NewThinkingStreamFilter(enabled bool) *ThinkingStreamFilter {
	return &ThinkingStreamFilter{enabled: enabled}
}

// Process takes a chunk of text and returns the filtered output
// If enabled=false, returns the original text unchanged
// If enabled=true, filters out <think>...</think> blocks
func (f *ThinkingStreamFilter) Process(chunk string) string {
	if !f.enabled {
		return chunk
	}

	result := ""
	text := f.buffer + chunk
	f.buffer = ""

	for {
		if f.inside {
			// Look for closing tag
			idx := strings.Index(text, "</think>")
			if idx == -1 {
				// Still inside, buffer remaining
				f.buffer = text
				return result
			}
			// Found closing tag
			f.inside = false
			text = text[idx+8:] // skip </think>
		} else {
			// Look for opening tag
			idx := strings.Index(text, "<think>")
			if idx == -1 {
				// No opening tag found
				// Check if text ends with partial "<think"
				if strings.HasSuffix(text, "<") ||
					strings.HasSuffix(text, "<t") ||
					strings.HasSuffix(text, "<th") ||
					strings.HasSuffix(text, "<thi") ||
					strings.HasSuffix(text, "<thin") ||
					strings.HasSuffix(text, "<think") {
					// Buffer the partial tag
					lastIdx := strings.LastIndex(text, "<")
					f.buffer = text[lastIdx:]
					result += text[:lastIdx]
				} else {
					result += text
				}
				return result
			}
			// Found opening tag
			result += text[:idx]
			text = text[idx+7:] // skip <think>
			f.inside = true
		}
	}
}

// Flush returns any remaining buffered content (should be called at end of stream)
func (f *ThinkingStreamFilter) Flush() string {
	if !f.enabled {
		return f.buffer
	}
	// If we're inside a think block, discard the buffer
	if f.inside {
		return ""
	}
	return f.buffer
}

// StripThinking is a convenience function to filter thinking blocks from a complete string
func StripThinking(text string, enabled bool) string {
	if !enabled {
		return text
	}
	filter := NewThinkingStreamFilter(true)
	result := filter.Process(text)
	result += filter.Flush()
	return result
}
