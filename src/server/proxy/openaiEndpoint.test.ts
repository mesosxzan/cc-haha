import { describe, expect, test } from 'bun:test'
import { buildOpenaiEndpoint } from './openaiEndpoint.js'

describe('buildOpenaiEndpoint', () => {
  for (const endpoint of ['chat/completions', 'responses'] as const) {
    for (const [base, expected] of [
      ['https://gw.apismart.ai', 'https://gw.apismart.ai'],
      ['https://gw.apismart.ai/', 'https://gw.apismart.ai'],
      ['https://gw.apismart.ai/v1', 'https://gw.apismart.ai/v1'],
      ['https://gw.apismart.ai/v1/', 'https://gw.apismart.ai/v1'],
    ] as const) {
      test(`${endpoint} appends the action to ${base} without inserting a version`, () => {
        expect(buildOpenaiEndpoint(base, endpoint)).toBe(`${expected}/${endpoint}`)
      })
    }
    test(`${endpoint} preserves gateway path prefixes`, () => {
      expect(buildOpenaiEndpoint('https://example.com/api/v1/', endpoint))
        .toBe(`https://example.com/api/v1/${endpoint}`)
      expect(buildOpenaiEndpoint('https://example.com/api', endpoint))
        .toBe(`https://example.com/api/${endpoint}`)
    })
    // #1816: gateways that version their own root serve OpenAI routes directly under it
    // (Volcengine Ark /api/v3 and /api/coding/v3, Zhipu /api/paas/v4).
    for (const base of [
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://ark.cn-beijing.volces.com/api/coding/v3',
      'https://open.bigmodel.cn/api/paas/v4',
    ]) {
      test(`${endpoint} uses ${base} as-is because it already ends in a version segment`, () => {
        expect(buildOpenaiEndpoint(base, endpoint)).toBe(`${base}/${endpoint}`)
        expect(buildOpenaiEndpoint(`${base}//`, endpoint)).toBe(`${base}/${endpoint}`)
      })
    }
    // The user-entered base is the complete base: bare roots and non-standard
    // paths get only the action suffix, never an inserted /v1.
    test(`${endpoint} uses bare gateway roots as-is`, () => {
      expect(buildOpenaiEndpoint('https://api.atlascloud.ai', endpoint))
        .toBe(`https://api.atlascloud.ai/${endpoint}`)
      expect(buildOpenaiEndpoint('http://localhost:11434/', endpoint))
        .toBe(`http://localhost:11434/${endpoint}`)
    })
    test(`${endpoint} uses non-standard base paths as-is`, () => {
      expect(buildOpenaiEndpoint('https://example.com/v1beta', endpoint))
        .toBe(`https://example.com/v1beta/${endpoint}`)
      expect(buildOpenaiEndpoint('https://example.com/api/v3/tenant', endpoint))
        .toBe(`https://example.com/api/v3/tenant/${endpoint}`)
    })
  }

  test('supports classic Azure OpenAI deployment URLs and preserves api-version query params', () => {
    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com/openai/deployments/gpt-4o?api-version=2024-10-21', 'chat/completions'),
    ).toBe('https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com/openai/deployments/gpt-4o', 'chat/completions'),
    ).toBe('https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com?api-version=2024-10-21', 'chat/completions', { modelId: 'gpt-4o-prod' }),
    ).toBe('https://my-res.openai.azure.com/openai/deployments/gpt-4o-prod/chat/completions?api-version=2024-10-21')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com?api-version=2025-04-01-preview', 'responses', { modelId: 'gpt-5' }),
    ).toBe('https://my-res.openai.azure.com/openai/responses?api-version=2025-04-01-preview')

    // Azure Responses API does not live under /deployments/{deployment}; strip the deployment segment.
    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com/openai/deployments/gpt-5?api-version=2025-04-01-preview', 'responses'),
    ).toBe('https://my-res.openai.azure.com/openai/responses?api-version=2025-04-01-preview')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com/openai/deployments/gpt-5', 'responses'),
    ).toBe('https://my-res.openai.azure.com/openai/responses?api-version=2024-10-21')
  })

  test('supports modern Azure OpenAI / Azure AI Foundry v1 endpoints', () => {
    expect(
      buildOpenaiEndpoint('https://my-res.services.ai.azure.com/openai/v1', 'chat/completions'),
    ).toBe('https://my-res.services.ai.azure.com/openai/v1/chat/completions')

    expect(
      buildOpenaiEndpoint('https://my-res.services.ai.azure.com/openai/v1', 'responses'),
    ).toBe('https://my-res.services.ai.azure.com/openai/v1/responses')

    expect(
      buildOpenaiEndpoint('https://my-res.openai.azure.com', 'chat/completions'),
    ).toBe('https://my-res.openai.azure.com/openai/v1/chat/completions')

    expect(
      buildOpenaiEndpoint('http://127.0.0.1:4000', 'chat/completions', { forceAzure: true }),
    ).toBe('http://127.0.0.1:4000/openai/v1/chat/completions')
  })
})
