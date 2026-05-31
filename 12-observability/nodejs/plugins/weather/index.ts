import { definePluginEntry } from '../../src/plugin-sdk/define.ts';

export default definePluginEntry({
  id: 'weather',
  name: 'Weather Tool',
  description: 'Provides weather query via wttr.in',

  register(api) {
    api.registerTool({
      name: 'weather_get',
      description: '获取指定城市的当前天气和预报。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名或机场代码，如 London、PEK、Tokyo' },
          format: { type: 'string', description: '输出格式：brief（单行）或 forecast（3日预报），默认 brief' },
        },
        required: ['city'],
      },
      async execute(_sessionId, params) {
        // Heavy deps loaded lazily so plugin registration stays fast
        const { spawnSafe } = await import('../../src/tools.ts');
        const fmt = params['format'] === 'forecast' ? '' : '?format=3';
        const city = encodeURIComponent(params['city'] ?? '');
        return spawnSafe('curl', ['-s', `wttr.in/${city}${fmt}`]);
      },
    });
  },
});
