#!/usr/bin/env node
/**
 * ACP 모드 대형 프롬프트 테스트
 * - 시스템 아규먼트 사이즈 제한 (128KB) 을 초과하는 다양한 크기의 프롬프트 테스트
 * - ACP 가 stdio JSON-RPC 를 통해 대용량 프롬프트를 직접 처리하는지 확인
 */

import { runStreamAcp } from './packages/provider-cline-cli/dist/index.js';
import { EventEmitter } from 'events';

// 테스트 사이즈 (bytes)
const TEST_SIZES = [
  { name: '128KB (argv 제한)', size: 128 * 1024 },
  { name: '256KB', size: 256 * 1024 },
  { name: '512KB', size: 512 * 1024 },
  { name: '1MB', size: 1024 * 1024 },
  { name: '2MB', size: 2 * 1024 * 1024 },
];

async function testAcpWithSize(testName, promptSize) {
  console.log(`\n=== 테스트: ${testName} (${promptSize.toLocaleString()} bytes) ===`);
  
  // 대형 프롬프트 생성 (반복 패턴)
  const pattern = "이것은 테스트 프롬프트의 한 줄입니다. ACP 모드가 대형 프롬프트를 정상적으로 처리할 수 있는지 확인합니다. ";
  const repeatCount = Math.ceil(promptSize / pattern.length);
  const prompt = pattern.repeat(repeatCount).substring(0, promptSize);
  
  console.log(`프롬프트 생성 완료: ${prompt.length.toLocaleString()} bytes`);
  
  const events = [];
  const emitter = new EventEmitter();
  
  const startTime = Date.now();
  
  try {
    // RunInput 인터페이스에 맞게 수정
    const stream = await runStreamAcp({
      prompt: prompt, // 문자열 직접 전달
      usePromptFile: false, // ACP 는 파일 우회 없이 직접 처리
      options: {
        command: 'cline',
        timeoutMs: 120000, // 2 분
        cwd: process.cwd(),
        extraArgs: [],
      },
    }, emitter);
    
    let fullText = '';
    let eventCount = 0;
    let parseErrors = 0;
    
    for await (const event of stream) {
      eventCount++;
      events.push(event.type);
      
      if (event.type === 'text-delta') {
        fullText += event.delta;
      } else if (event.type === 'error') {
        console.error(`에러: ${event.error}`);
      } else if (event.type === 'finish') {
        parseErrors = event.parseErrors;
      }
      
      // 첫 토큰 시간
      if (eventCount === 1) {
        const firstTokenTime = Date.now() - startTime;
        console.log(`첫 토큰: ${firstTokenTime}ms`);
      }
    }
    
    const totalTime = Date.now() - startTime;
    
    console.log(`총 이벤트: ${eventCount}`);
    console.log(`응답 시간: ${totalTime}ms`);
    console.log(`수신 텍스트: ${fullText.length.toLocaleString()} bytes`);
    console.log(`이벤트 타입: ${[...new Set(events)].join(', ')}`);
    
    return {
      success: true,
      testName,
      promptSize: prompt.length,
      responseSize: fullText.length,
      eventCount,
      totalTime,
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`테스트 실패: ${error.message}`);
    
    return {
      success: false,
      testName,
      promptSize: prompt.length,
      error: error.message,
      totalTime,
    };
  }
}

async function runAllTests() {
  console.log('='.repeat(60));
  console.log('ACP 대형 프롬프트 테스트 스위트');
  console.log('='.repeat(60));
  
  const results = [];
  
  for (const test of TEST_SIZES) {
    const result = await testAcpWithSize(test.name, test.size);
    results.push(result);
    
    // 테스트 간 약간의 딜레이
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // 결과 요약
  console.log('\n' + '='.repeat(60));
  console.log('테스트 결과 요약');
  console.log('='.repeat(60));
  
  console.log('\n| 테스트 | 프롬프트 크기 | 결과 | 응답 시간 | 응답 크기 |');
  console.log('|--------|--------------|------|----------|----------|');
  
  for (const r of results) {
    const status = r.success ? '✅ 성공' : `❌ 실패 (${r.error})`;
    const responseSize = r.success ? `${r.responseSize.toLocaleString()} bytes` : '-';
    const totalTime = r.success ? `${r.totalTime}ms` : '-';
    console.log(`| ${r.testName} | ${r.promptSize.toLocaleString()} bytes | ${status} | ${totalTime} | ${responseSize} |`);
  }
  
  const successCount = results.filter(r => r.success).length;
  console.log(`\n총계: ${successCount}/${results.length} 테스트 성공`);
  
  // 성공/실패 분석
  if (successCount < results.length) {
    console.log('\n⚠️ 실패 분석:');
    for (const r of results) {
      if (!r.success) {
        console.log(`  - ${r.testName}: ${r.error}`);
      }
    }
  } else {
    console.log('\n🎉 모든 테스트가 성공했습니다! ACP 모드는 argv 제한 없이 대형 프롬프트를 처리할 수 있습니다.');
  }
}

// 메인 실행
runAllTests().catch(console.error);
