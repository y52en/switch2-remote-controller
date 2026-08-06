# Remotion explanation video

`Switch 2 Remote Controller`の説明動画です。前半で遠隔操作のデモを見せ、後半でセットアップ手順を説明します。

## 構成

- 0:00–0:06 タイトル
- 0:06–0:24 遠隔操作デモ
- 0:24–0:34 通信構成
- 0:34–0:44 ESP32-C3への書き込み
- 0:44–0:53 ホストアプリ起動
- 0:53–1:01 Switch 2とのペアリング
- 1:01–1:10 共有URL発行
- 1:10–1:15 エンディング

実機映像を使わず、リポジトリの操作画面を再現したアニメーションだけで完結する構成です。

## プレビュー

```sh
cd video
npm install
npm start
```

Remotion Studioが開いたら、`Switch2RemoteController`を選択してください。

## MP4を書き出す

```sh
cd video
npm install
npm run render
```

出力先:

```text
video/out/switch2-remote-controller.mp4
```

## ポスター画像を書き出す

```sh
cd video
npm install
npm run still
```

出力先:

```text
video/out/poster.png
```

## 編集箇所

映像、字幕、タイミングは`src/Video.tsx`にまとまっています。動画全体は30 fps、1920×1080、75秒です。

実機映像へ差し替える場合は、素材を`video/public/`へ置き、Remotionの`<Video>`または`<OffthreadVideo>`でデモ区間に重ねてください。シリアル番号、ルームコード、ユーザー名などが映り込まないよう注意してください。
