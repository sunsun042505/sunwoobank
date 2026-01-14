# SunwooBank v5 (Netlify)
- 고객: index.html (Netlify Identity 로그인)
- 텔러: teller.html (자체 코드 0612)
- 공용 DB: Netlify Blobs (db.json)

## Netlify 설정
1) Identity Enable, Invite-only, Email confirmation OFF
2) Functions 동작 확인: /.netlify/functions/bank?ping=1 -> pong
3) (선택) 인터넷뱅킹 계정 즉시 생성(B): 환경변수 IDENTITY_ADMIN_TOKEN 설정 필요
