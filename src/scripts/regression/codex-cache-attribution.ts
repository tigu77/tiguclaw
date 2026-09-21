import { summarizeCacheAttribution } from "../../core/llm-runtime/adapters/_codex-cache-attribution.js";
import { parseCodexSse } from "../../core/llm-runtime/adapters/openai-codex-oauth-history.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
const row = { input_tokens: 10, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 2 };
const parse = async (attribution: unknown) => parseCodexSse(new ReadableStream<Uint8Array>({start(c) {
  c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type:"response.completed",response:{id:"test",usage:{input_tokens:20,output_tokens:4,input_tokens_details:{cached_tokens:0},attribution}}})}\n\n`)); c.close();
}}));
export const check: RegressionCheck = {
  name: "codex-cache-attribution",
  guards: "캐시 원인 진단에서 누락을 0으로, 부분합을 전체로, 중첩 content를 별도 요청으로 오인하거나 원문·ID를 로그에 싣는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const raw = {request_fields:{instructions:row,tools:{input_tokens:0,cached_tokens:0},secret:"PRIVATE"},items:{PRIVATE_ID:{...row,content:[row],text:"PRIVATE"},second:row}};
    const result = summarizeCacheAttribution(raw);
    out.push(assert("명시 0은 보존", result?.instructions?.cached_tokens === 0 && result.tools?.input_tokens === 0, result));
    out.push(assert("items는 부모 행만 합산, content 중복 계산 없음", result?.items?.input_tokens === 20 && result.items.count === 2 && result.items.output_tokens === 4, result));
    out.push(assert("원문·ID·미지원 키는 제거", !JSON.stringify(result).includes("PRIVATE") && !JSON.stringify(result).includes("content"), result));
    for (const bad of [undefined,null,[],"wrong",{}]) out.push(assert("형식 누락을 사용량 0으로 대체하지 않음", summarizeCacheAttribution(bad) === undefined, {bad}));
    const partial=summarizeCacheAttribution({items:{a:row,b:{input_tokens:5}}});
    out.push(assert("누락된 캐시/출력의 부분 합계를 표시하지 않음", partial?.items?.input_tokens === 15 && partial.items.cached_tokens === undefined && partial.items.output_tokens === undefined, partial));
    for (const invalid of [-1,0.5,"3",Infinity,NaN,Number.MAX_SAFE_INTEGER+1]) {
      const value=summarizeCacheAttribution({request_fields:{instructions:{input_tokens:invalid,cached_tokens:0}}});
      out.push(assert("잘못된 숫자는 생략하고 유효한 0은 보존", value?.instructions?.input_tokens === undefined && value?.instructions?.cached_tokens === 0, value));
    }
    const excessive=summarizeCacheAttribution({items:{a:{input_tokens:1,cached_tokens:2,cache_write_tokens:3}}});
    out.push(assert("입력 초과 캐시 수치는 합계에서 제외", excessive?.items?.input_tokens === 1 && excessive.items.cached_tokens === undefined && excessive.items.cache_write_tokens === undefined, excessive));
    const overflow=summarizeCacheAttribution({items:{a:{input_tokens:Number.MAX_SAFE_INTEGER},b:row}});
    out.push(assert("합계 안전 정수 초과는 생략", overflow?.items?.input_tokens === undefined, overflow));
    const malformed=summarizeCacheAttribution({items:{a:row,b:null}});
    out.push(assert("손상된 행을 누락시켜 부분합을 만들지 않음", malformed?.items?.count === 2 && malformed.items.input_tokens === undefined, malformed));
    const saved=process.env.CODEX_CACHE_CURVE;
    try {
      process.env.CODEX_CACHE_CURVE="1";
      const enabled=await parse(raw);
      out.push(assert("실제 SSE가 진단 요약을 전달", JSON.stringify(enabled.cacheAttribution) === JSON.stringify(result), enabled));
      const absent=await parse(undefined);
      out.push(assert("다음 응답에 이전 진단을 재사용하지 않음", absent.cacheAttribution === undefined, absent));
      delete process.env.CODEX_CACHE_CURVE;
      const disabled=await parse(raw);
      out.push(assert("진단 꺼짐은 요약 없음, 원래 usage 불변", disabled.cacheAttribution === undefined && JSON.stringify(disabled.usage) === JSON.stringify(enabled.usage), disabled));
    } finally {if(saved===undefined)delete process.env.CODEX_CACHE_CURVE;else process.env.CODEX_CACHE_CURVE=saved;}
    return out;
  },
};
