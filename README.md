# 선우뱅크 (Netlify + GitHub) 데모

이 프로젝트는 **정적 페이지 + Netlify Functions + Netlify Identity + Netlify Blobs** 조합으로,
“고객 온라인뱅킹( index.html )”과 “직원 창구( teller.html )”를 같이 넣어둔 데모야.

> ⚠️ 실제 금융 서비스 아님. 보안/규정/검증 로직은 데모 수준.

## 폴더 구조

- `index.html` : 고객 화면(로그인, 계좌조회, 이체, 예·적금, 공과금, 카드, 내 정보, 고객센터)
- `teller.html` : 직원 창구 화면(이전에 만든 파일 그대로 포함)
- `netlify/functions/bank.js` : API (온라인 저장 포함)
- `netlify.toml` : functions 경로 지정
- `package.json` : `@netlify/blobs` 의존성

## Netlify에서 켜야 하는 것 (중요)

1) Netlify에 GitHub 레포 연결해서 배포  
2) Netlify 대시보드 → **Identity** → Enable  
   - Registration은 일단 Open(테스트용) / Invite only(운영용) 원하는대로  
3) Deploy 다시 한 번

## 동작 원리

- 로그인/회원가입: **Netlify Identity 위젯**
- 데이터 저장: **Netlify Functions**에서 `@netlify/blobs`로 사용자별 JSON 저장
- 프론트에서 API 호출: `fetch("/.netlify/functions/bank", { authorization: "Bearer <token>" })`

## 로컬 테스트 (선택)

Netlify CLI 쓰면 편함:

- Netlify CLI 설치 후 `netlify dev` 실행  
- 로컬에서는 Identity 컨텍스트가 제한될 수 있어서, 제일 정확한 건 “배포된 URL”에서 테스트!



## 콘솔에 `/.netlify/identity/settings 404`가 뜰 때

이건 **코드 문제가 아니라**, 지금 페이지가 Netlify Identity가 켜진 “Netlify 사이트”로 서비스되고 있지 않다는 뜻이야.

- GitHub 미리보기/로컬(file://, localhost)에서는 항상 404
- Netlify 대시보드에서 해당 사이트의 **Identity를 Enable** 했는지 확인
- Enable 후에는 Deploys에서 **Trigger deploy** 한 번 눌러서 재배포
- 배포 URL에서 `/.netlify/identity/settings`를 열었을 때 JSON이 뜨면 정상
