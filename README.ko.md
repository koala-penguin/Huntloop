# Huntloop

[English](README.md) | 한국어

내 컴퓨터에서 돌리는 구직 도우미입니다. CV와 관심 있는 공고를 넣으면 어떤 공고가 실제로 가능성이 있는지, 왜 그런지
알려 줍니다. 지원하기로 하면 그 공고에 맞춘 CV를 써 주는데, 모든 문장은 내가 원래 쓴 내용에 근거해야 합니다.

호주 시장을 먼저 염두에 두고 만들었고 뉴질랜드·싱가포르·미국도 됩니다. 화면은 한국어와 영어를 지원합니다. Claude로
돌아가며, API 키나 내 Claude 구독으로 연결합니다.

![Head of Data 공고의 인터뷰 가능성 리포트](docs/screenshots/ko/01-interview-chance.png)

## 할 수 있는 일

- CV를 읽어 프로필로 정리합니다. 경력, 기간, 기술, 나라별 취업 자격까지.
- 공고를 링크, 본문, 스크린샷, PDF 어떤 형태로든 받아 인터뷰 가능성을 높음·좋음·도전·낮음으로 알려 줍니다. 판단마다
  공고 문장과 내 CV 문장이 근거로 붙습니다.
- 공고마다 Claude와 대화할 수 있고, 회사도 출처를 달아 조사해 줍니다.
- 맞춤 CV(Word, PDF)를 써 줍니다. CV에서 근거를 못 찾은 문장은 표시되고, 해결할 때까지 다운로드가 막힙니다.
- 지원 현황을 보드로 관리하고, 전체 구직을 놓고 이야기하는 코치 대화가 있습니다.
- Adzuna와 Claude 웹 검색으로 공고를 찾습니다. SEEK와 LinkedIn은 선택입니다.

## 스크린샷

<table>
  <tr>
    <td><img src="docs/screenshots/ko/02-profile.png" width="400" alt="프로필"><br>CV로 만든 프로필</td>
    <td><img src="docs/screenshots/ko/03-chat.png" width="400" alt="대화"><br>공고에 대해 묻기</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/ko/04-tailored-cv.png" width="400" alt="맞춤 CV"><br>검사 결과가 붙은 맞춤 CV</td>
    <td><img src="docs/screenshots/ko/05-pipeline.png" width="400" alt="지원 현황"><br>지원 현황</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/ko/06-search.png" width="400" alt="검색"><br>검색 결과 (데모 모드)</td>
    <td><img src="docs/screenshots/ko/08-settings-connection.png" width="400" alt="Claude 연결"><br>API 키 또는 구독</td>
  </tr>
</table>

<sub>지원자와 회사는 가상입니다. Claude 구독에서 Opus 5.5로 실제로 돌린 화면입니다. 호주 공고라 CV와 공고 원문은
영어이고, 화면과 AI 설명은 한국어입니다.</sub>

## 시작하기

Node.js 20.9 이상이 필요합니다.

```bash
npm install
cp .env.example .env.local
npm run build && npm start   # http://127.0.0.1:3000
```

Claude를 연결하지 않으면 데모 모드로 돌아가서, AI 답변은 흉내만 내고 비용 없이 전부 눌러 볼 수 있습니다. 데이터는 내
컴퓨터의 `./data`에만 저장됩니다.

## Claude 연결

**설정 → Claude 연결**에서 고르고, 언제든 바꿀 수 있습니다.

- **API 키**: `.env.local`에 `ANTHROPIC_API_KEY`를 넣습니다. 토큰 단위로 과금되고, 일간·월간 상한을 정할 수 있습니다.
- **Claude 구독**: Claude Code를 설치하고(`npm install -g @anthropic-ai/claude-code`) `claude auth login`으로 로그인한 뒤,
  설정에서 **다시 확인**과 **이걸로 사용**을 누릅니다. 따로 청구되지 않고 Pro나 Max 플랜 사용량에서 차감됩니다.

Huntloop는 Claude 로그인 정보를 보지 않고, 내 `claude` 명령을 실행할 뿐입니다. CV 읽기, 공고 세 개 평가, 대화, 맞춤 CV까지
한 번 쭉 돌리면 API 가격으로 약 $1입니다.

SEEK와 LinkedIn은 기본으로 꺼져 있습니다. 두 사이트 모두 이용약관에서 자동화된 접근을 허용하지 않으니, 켜기 전에 설정에
나오는 안내를 읽어 보세요.

## 더 보기

평가 방식, CV 검사, 검색과 브라우징 에이전트, Claude 연결, 비용은 [안내서](docs/guide.ko.md)에 자세히 있습니다.

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 |
| `npm run lint && npm run typecheck && npm test` | 커밋 전에 돌리는 검사 |
| `npm run test:e2e` | 가짜 AI로 돌리는 브라우저 테스트 |

MIT 라이선스.
