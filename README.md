# SunwooBank (Netlify + GitHub)

## 구조
- index.html : 고객(인터넷뱅킹) 화면 — Netlify Identity 로그인
- teller.html : 창구(텔러) 화면 — 자체 로그인(코드 0612)
- netlify/functions/bank.js : API + Netlify Blobs(DB)

## 필수 Netlify 설정
1) Site settings → Identity → Enable
2) Identity → Registration → Invite only (사용자 설정대로)
3) (B 방식) Site settings → Environment variables 에 아래 추가:
   - IDENTITY_ADMIN_TOKEN : Netlify Identity Admin API 토큰(GoTrue admin JWT)

> 이 토큰이 없으면 텔러의 "인터넷뱅킹 가입(계정 생성)" 기능만 실패하고,
> 나머지(공용DB/계좌/이체/입출금)는 정상 동작합니다.

## 테스트
- Functions 핑: /.netlify/functions/bank?ping=1 → pong
- 고객: 로그인 후 계좌조회/이체
- 텔러: 코드 0612로 로그인 후 고객/계좌 생성, 입출금, 이체, 상품가입, 인터넷뱅킹 가입(계정 생성)
