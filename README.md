# SunwooBank (Supabase) - Netlify 배포용 데모

## 구성
- 고객: `/index.html` (메인) — Supabase 이메일/비번 로그인 후 계좌조회/이체/거래내역
- 텔러: `/teller.html` — 코드(기본 0612)로 자체 로그인 후 고객검색/고객등록/계좌개설/입출금/이체/제신고/거래제한/한도계좌 해제/인터넷뱅킹 가입

## Supabase 준비
1) Supabase 프로젝트 생성
2) SQL Editor에서 `supabase/schema.sql` 실행

> ⚠️ "식별번호(13자리)" 입력칸은 **실제 주민등록번호 입력 금지** (데모용 가짜 숫자만). 서버에는 해시로만 저장됩니다.

## Netlify 환경변수 (Site settings → Environment variables)
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY  (서버 전용, 절대 브라우저/깃허브에 넣지 말기)
- TELLER_CODE = 0612
- RRN_SALT = 길고 랜덤한 문자열(권장 32자+)

## 이메일 확인(Email Confirmations)
- 텔러가 계정 생성 시 `email_confirm: true`를 무조건 적용해서 "이메일 확인 없이" 바로 로그인 가능하게 처리.

## 배포 확인
- `/.netlify/functions/bank?ping=1` → pong
- 고객: `/`
- 텔러: `/teller.html`


## 500 에러(POST /.netlify/functions/bank) 디버그
- 먼저 `/.netlify/functions/bank?config=1` 열어서 JSON이 뜨는지 확인
  - 500이면: Netlify 환경변수 3개(SUPABASE_URL/ANON/SERVICE_ROLE)가 누락/오타/재배포 미반영 가능성이 큼
- Supabase SQL Editor에서 `supabase/schema.sql` 실행했는지 확인(테이블 없으면 500)
- Netlify → Deploys → Functions → bank → Logs 에서 에러 메시지 확인

(v2부터는 화면에서 에러 메시지가 더 자세히 보이게 수정됨)
