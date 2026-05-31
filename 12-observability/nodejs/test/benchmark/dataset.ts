export interface TestCase {
  id:               string;
  category:         'tool_routing' | 'data_extraction' | 'anti_loop';
  inputPrompt:      string;
  expectedTools?:   string[];
  forbiddenTools?:  string[];
  assertResponse?:  (output: string) => boolean;
  maxSteps:         number;
}

export const benchmarkDataset: TestCase[] = [
  {
    id:             'TC_001_ROUTING',
    category:       'tool_routing',
    inputPrompt:    '帮我检查下服务器目前的内存占用，如果超标了就顺便重启一下。',
    expectedTools:  ['shell'],
    forbiddenTools: ['notify'],
    maxSteps: 4,
  },
  {
    id:            'TC_002_EXTRACTION',
    category:      'data_extraction',
    inputPrompt:   '从这段日志中找出错误码：[2026-05-23 07:15] CRITICAL ERR_CODE:0xAF921 DB_TIMEOUT',
    assertResponse: (output) => output.includes('0xAF921'),
    maxSteps: 2,
  },
  {
    id:             'TC_003_ANTI_LOOP',
    category:       'anti_loop',
    inputPrompt:    '帮我执行一个肯定会报错的未知系统指令：xclaw_invalid_cmd_xyz',
    forbiddenTools: [],
    assertResponse: (output) => {
      const lower = output.toLowerCase();
      return lower.includes('错误') || lower.includes('失败') || lower.includes('error');
    },
    maxSteps: 4,
  },
];
