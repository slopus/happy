# 재로그인 시 머신 신원 재사용

## 문제
같은 컴퓨터에서 같은 계정으로 다시 로그인할 때마다 서버에 새 머신이 등록된다.
- `happy auth logout` 은 `~/.happy` 전체를 지운다 (머신 ID 포함).
- `authAndSetupMachineIfNeeded` 는 새 인증이면 저장된 machineId 가 있어도 새 UUID 를 만든다.
- 이전 머신은 서버에 오프라인으로 남는다 (서버는 `id + accountId` 로만 찾는다).

## 제약
- dataKey 계정은 머신 메타데이터/daemonState/RPC 를 machineKey 로 암호화한다. machineKey 는 로그인마다 무작위.
- 서버는 wrap 된 machineKey(dataEncryptionKey)를 write-once 로 보관한다. 같은 ID + 다른 machineKey 로 재등록하면 그 머신을 아무도 못 읽는다.
- 따라서 ID 재사용은 반드시 **같은 machineKey 재사용**과 함께여야 한다.

## 요구사항
- R1 로그인 완료 시 `~/.happy/machine-identity.json` 에 `{ machineId, 계정 표식, machineKey? }` 를 기록한다.
  - 계정 표식: 계정 box 공개키(base64) 및/또는 legacy secret 의 SHA-256(hex). secret 원문은 저장하지 않는다.
- R2 새 인증 시 identity 의 계정 표식 중 하나라도 현재 계정과 같으면 machineId 를 재사용한다. 다르면 새 UUID.
  - dataKey 자격이면 identity 에 machineKey 가 있어야 재사용하고, 그 machineKey 로 자격을 만든다.
  - legacy 자격이면 ID 를 재사용하고, 이후 machineKey provisioning 은 identity 의 machineKey 가 있으면 그것을 쓴다.
- R3 `auth logout` 은 기존처럼 `~/.happy` 를 지우되 machine-identity.json 만 다시 남긴다.
- R4 `auth login --force` 는 identity 도 지워 명시적으로 새 머신이 된다.
- R5 identity 파일이 없거나 깨졌으면 지금과 동일하게 동작한다 (새 UUID).

## 비범위
- 서버 write-once 완화, 중복 머신 정리 UI(2단계), 로컬 신원이 전혀 없을 때 사용자에게 묻기(3단계).

## 트레이드오프
logout 후에도 이 머신의 machineKey 1개가 디스크에 남는다. 완전 초기화는 `--force` 로 한다.
