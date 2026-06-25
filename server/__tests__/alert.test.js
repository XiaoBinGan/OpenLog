import { describe, it, expect } from 'vitest';
import {
  normalizeAlertSig,
  matchAlertPatterns,
  matchesSeverityFilter,
} from '../index.js';

describe('告警逻辑测试', () => {
  describe('normalizeAlertSig()', () => {
    it('应移除以星期开头的 syslog 时间戳', () => {
      const input = 'Mon Jun 23 14:30:15 CST 2025 - Connection refused';
      const result = normalizeAlertSig(input);
      expect(result).toBe('Connection refused');
    });

    it('应移除 ISO 8601 时间戳前缀', () => {
      const input = '2025-06-23T14:30:15Z - Something went wrong';
      const result = normalizeAlertSig(input);
      expect(result).toBe('Something went wrong');
    });

    it('应移除带空格分隔的 ISO 日期', () => {
      const input = '2025-06-23 14:30:15 ERROR - database connection failed';
      const result = normalizeAlertSig(input);
      expect(result).toBe('ERROR - database connection failed');
    });

    it('应将 req_xxx 替换为 req_XXX', () => {
      const input = 'Failed to process req_abc123def456 and req_000000000000';
      const result = normalizeAlertSig(input);
      expect(result).not.toContain('req_abc123def456');
      expect(result).not.toContain('req_000000000000');
      expect(result).toContain('req_XXX');
    });

    it('应将 UUID 替换为 UUID 占位符', () => {
      const input = 'Error processing 550e8400-e29b-41d4-a716-446655440000';
      const result = normalizeAlertSig(input);
      expect(result).not.toContain('550e8400');
      expect(result).toContain('UUID');
    });

    it('空字符串应返回空字符串', () => {
      expect(normalizeAlertSig('')).toBe('');
    });

    it('null/undefined 应返回空字符串', () => {
      expect(normalizeAlertSig(null)).toBe('');
      expect(normalizeAlertSig(undefined)).toBe('');
    });

    it('应截断到 120 字符', () => {
      const longLine = 'A'.repeat(200);
      const result = normalizeAlertSig(longLine);
      expect(result.length).toBeLessThanOrEqual(120);
    });

    it('无特殊模式的普通文本应保持不变', () => {
      const input = 'just a normal error message without any special patterns';
      const result = normalizeAlertSig(input);
      expect(result).toBe(input.slice(0, 120));
    });

    it('大小写变体的 UUID 应被替换', () => {
      const input = 'Error: 550E8400-E29B-41D4-A716-446655440000 processing';
      const result = normalizeAlertSig(input);
      expect(result).not.toContain('550E8400');
      expect(result).toContain('UUID');
    });

    it('应去除首尾空白', () => {
      const input = '   \n  Error occurred   \n';
      const result = normalizeAlertSig(input);
      expect(result).toBe('Error occurred');
    });
  });

  describe('matchAlertPatterns()', () => {
    it('无 patterns 时应返回 true', () => {
      expect(matchAlertPatterns('anything', null)).toBe(true);
      expect(matchAlertPatterns('anything', '')).toBe(true);
      expect(matchAlertPatterns('anything', undefined)).toBe(true);
    });

    it('pattern 中找到关键词时应返回 true', () => {
      expect(matchAlertPatterns('ERROR: connection failed', 'ERROR')).toBe(true);
      expect(matchAlertPatterns('Fatal error occurred', 'ERROR,FATAL')).toBe(true);
      expect(matchAlertPatterns('An Exception happened', 'ERROR,Exception')).toBe(true);
    });

    it('pattern 中无匹配关键词时应返回 false', () => {
      expect(matchAlertPatterns('INFO: all systems operational', 'ERROR,FATAL')).toBe(false);
      expect(matchAlertPatterns('DEBUG: processing request', 'ERROR,WARN')).toBe(false);
    });

    it('应大小写不敏感匹配', () => {
      expect(matchAlertPatterns('error: connection failed', 'ERROR')).toBe(true);
      expect(matchAlertPatterns('FATAL ERROR', 'error')).toBe(true);
      expect(matchAlertPatterns('Warning: something', 'warn')).toBe(true);
    });

    it('patterns 中空字符串/空白关键词应被忽略', () => {
      expect(matchAlertPatterns('ERROR occurred', ',ERROR,')).toBe(true);
      expect(matchAlertPatterns('INFO message', ',   ,')).toBe(true);  // all empty -> true
    });

    it('空内容字符串应正确匹配', () => {
      expect(matchAlertPatterns('', 'ERROR')).toBe(false);
      expect(matchAlertPatterns('', '')).toBe(true);
      expect(matchAlertPatterns('', null)).toBe(true);
    });

    it('逗号分隔的多个关键词任意一个匹配即返回 true', () => {
      expect(matchAlertPatterns('WARN: low memory', 'ERROR,FATAL,WARN')).toBe(true);
      expect(matchAlertPatterns('ERROR: disk full', 'ERROR,FATAL,WARN')).toBe(true);
      expect(matchAlertPatterns('FATAL: kernel panic', 'ERROR,FATAL,WARN')).toBe(true);
      expect(matchAlertPatterns('INFO: all good', 'ERROR,FATAL,WARN')).toBe(false);
    });

    it('关键词包含特殊字符应能匹配', () => {
      expect(matchAlertPatterns('500 Internal Server Error', '500')).toBe(true);
      expect(matchAlertPatterns('MemoryError: out of memory', 'MemoryError')).toBe(true);
    });

    it('带空格的 patterns 应正确处理', () => {
      expect(matchAlertPatterns('ERROR occurred', ' ERROR ,  FATAL ')).toBe(true);
      expect(matchAlertPatterns('INFO message', ' ERROR ,  FATAL ')).toBe(false);
    });
  });

  describe('matchesSeverityFilter()', () => {
    it('无 severityFilter 时应返回 true', () => {
      expect(matchesSeverityFilter('ERROR', null)).toBe(true);
      expect(matchesSeverityFilter('ERROR', '')).toBe(true);
      expect(matchesSeverityFilter('ERROR', undefined)).toBe(true);
    });

    it('匹配的等级应返回 true', () => {
      expect(matchesSeverityFilter('ERROR', 'ERROR')).toBe(true);
      expect(matchesSeverityFilter('FATAL', 'ERROR,FATAL')).toBe(true);
      expect(matchesSeverityFilter('WARN', 'ERROR,WARN,INFO')).toBe(true);
    });

    it('不匹配的等级应返回 false', () => {
      expect(matchesSeverityFilter('INFO', 'ERROR,FATAL')).toBe(false);
      expect(matchesSeverityFilter('DEBUG', 'ERROR,WARN')).toBe(false);
    });

    it('应大小写不敏感', () => {
      expect(matchesSeverityFilter('error', 'ERROR')).toBe(true);
      expect(matchesSeverityFilter('Error', 'error,fatal')).toBe(true);
      expect(matchesSeverityFilter('FATAL', 'error,fatal')).toBe(true);
    });

    it('null/undefined lineLevel 应视为 INFO', () => {
      expect(matchesSeverityFilter(null, 'INFO')).toBe(true);
      expect(matchesSeverityFilter(undefined, 'ERROR')).toBe(false);
      expect(matchesSeverityFilter(null, '')).toBe(true);
    });

    it('空字符串 severityFilter 关键词应被忽略', () => {
      // 逗号分隔的空字符串应被 filter(Boolean) 移除
      expect(matchesSeverityFilter('ERROR', ',ERROR,')).toBe(true);
    });

    it('逗号分隔的多个等级', () => {
      expect(matchesSeverityFilter('ERROR', 'ERROR,FATAL,WARN')).toBe(true);
      expect(matchesSeverityFilter('FATAL', 'ERROR,FATAL,WARN')).toBe(true);
      expect(matchesSeverityFilter('WARN', 'ERROR,FATAL,WARN')).toBe(true);
      expect(matchesSeverityFilter('INFO', 'ERROR,FATAL,WARN')).toBe(false);
    });
  });
});