# Switch 2 Remote Controller

[English](README.md)

ESP32-C3を使った実験的なリモートコントローラーです。ブラウザの入力を
ローカルのNode.jsブリッジへ送り、USB Serial/JTAG経由でESP32-C3へ転送し、
ESP32-C3が3つの独立したBluetooth LEコントローラーとしてNintendo Switch 2へ
接続します。

> Nintendoとは無関係の非公式コミュニティプロジェクトです。システム更新に
> よってコントローラー互換性が変わる可能性があります。

## 構成

```text
リモートブラウザ -- WebRTC DataChannel --> ホストブラウザ
                                               |
                                               | ローカルWebSocket
                                               v
                                         Node.jsホスト
                                               |
                                               | USB Serial/JTAG
                                               v
                                            ESP32-C3
                                               |
                                               | 3つのBLE ID / 接続
                                               v
                                      Nintendo Switch 2

Cloudflare Worker: シグナリングと任意のTURN認証情報のみ
```

通常の操作データはブラウザ間を直接流れます。Cloudflare WorkerはWebRTC接続の
確立とTURN認証情報の提供だけを行い、ローカルUSB接続には関与しません。

## 対応ハードウェア

- 4 MBフラッシュとUSB Serial/JTAGを持つ汎用ESP32-C3: headlessプロファイル。
- 240x240 GC9A01丸型LCD搭載2424S012C: 任意のLCDプロファイル。
- Node.js 24と`uv`を実行できるWindows、macOS、Linux。

標準はheadless版で、LCDのSPIやGPIOを初期化しません。LCD版では
2424S012C基板内で次のように配線されています。

| GC9A01信号 | ESP32-C3 GPIO |
| --- | ---: |
| RST | 1 |
| DC | 2 |
| BL | 3 |
| SCK | 6 |
| MOSI | 7 |
| CS | 10 |

これらのピンを設定するのはLCDプロファイルだけです。LCD版では同じGPIOへ
別の周辺機器を接続しないでください。

## ファームウェア

[uv](https://docs.astral.sh/uv/)をインストールして実行します。

```sh
uv sync --frozen
uv run --frozen python scripts/firmware.py build --profile headless
```

2424S012CのLCD版は次のコマンドです。

```sh
uv run --frozen python scripts/firmware.py build --profile lcd-2424s012c
```

ポートを実機に合わせて書き込みます。

```sh
uv run --frozen python scripts/firmware.py upload --profile headless --port COM3
```

Linuxでは`/dev/ttyACM0`、macOSでは`/dev/cu.usbmodem*`などを指定します。
書き込み前にESP32-C3であることを検証します。PlatformIOと変更済みESP-IDFは
`.cache`内に隔離されます。

## ホストアプリ

```sh
npm ci
cp apps/host/.env.example apps/host/.env
# apps/host/.envのESP32_SERIAL_PORTを編集
npm run start:host
```

`http://127.0.0.1:8787`を開きます。ホストはローカルWebSocketだけを受け付け、
シリアル再接続、デジタル入力エッジの保持、ページ切断時のニュートラル送信を
行います。

3枚のコントローラーカードで、ローカル入力の送り先と各BLE接続の状態を個別に
確認できます。リモート参加者へ割り当てたカードはローカル側でロックされるため、
同じ仮想コントローラーを2人が同時操作することはありません。

## ペアリング

1. いずれかのプロファイルを書き込み、データ通信対応USBケーブルでESP32-C3を
   接続し直します。
2. ホストアプリを起動し、ローカルURLを開きます。
3. Switch 2でコントローラーのペアリング画面を開きます。
4. ブラウザで**コントローラー1**を選択し、画面上または割り当て済みの**L**と
   **R**を押してSwitch 2側で登録を完了します。
5. **コントローラー2**と**コントローラー3**でも繰り返します。各カードの状態は
   ペアリング中から接続済み／準備完了へ個別に変化します。
6. リモート用URLを発行する前に、全スロットのボタンとスティックを確認します。

3つのBLE IDはそれぞれ異なるアドレスを使い、NimBLEの相手アドレス単位のボンド
ストアに合わせて1つの永続LTKを共有します。ペアリング情報はESP32のフラッシュへ
保存されます。シリアルケーブルを抜く前にホストページを閉じ、ニュートラル復帰
処理が動作する状態にしてください。

## リモート接続

```sh
npm run dev:signaling
```

ローカルWorkerは`http://127.0.0.1:8788`で待ち受けるため、8787のホストと
同時に起動できます。

リポジトリ直下からWorkerをデプロイできます。

```sh
npm run deploy
```

デプロイ手順は[services/signaling/README.md](services/signaling/README.md)を参照して
ください。TURN認証情報はコミットせず、Wrangler secretsへ登録します。Workerは
静的assets、`ROOMS`というDurable Object binding、任意の`TURN_KEY_ID` /
`TURN_KEY_API_TOKEN` secretsを使用します。操作入力はWebRTC DataChannelを優先し、
P2Pが利用できない場合またはリレー固定モードではルーム経由へ切り替わります。
最初の3人には空いているコントローラースロットが自動割り当てされ、4人目以降は
ロビーで待機します。ホストは参加者一覧からスロットを個別に解放・再割り当てできます。

## トラブルシューティング

- **シリアルポートがない、または不正と表示される:** `apps/host/.env`の
  `ESP32_SERIAL_PORT`を設定します。Windowsはデバイスマネージャー、Linuxは
  `/dev/ttyACM*`、macOSは`/dev/cu.*`を確認してください。Linuxではシリアル機器を
  利用するグループ権限も必要な場合があります。
- **書き込み前に拒否される:** `esptool`がESP32-C3と判定できない場合は安全のため
  停止します。ポートを確認し、基板によってはブートローダーモードに入れてください。
- **コントローラーが見つからない:** Switch 2のペアリング画面を開き直し、ESP32-C3を
  再起動して、シリアル診断にBLE状態の変化が出るか確認します。
- **LCDが表示されない:** `lcd-2424s012c`をビルドして書き込んでください。標準の
  headless版は意図的にSPIと表示GPIOを操作しません。
- **リモート側が接続できない:** まず同一ネットワークで確認してください。NATをまたぐ
  接続では、上記のTURN secretsが必要になることがあります。
- **入力がニュートラルへ戻る:** ホストページ切断時、または1.2秒間新しい入力が
  届かなかった場合の正常な安全動作です。

## 検証

```sh
npm test
npm run check:signaling
cc -std=c11 -Wall -Wextra -Werror -pedantic -Ifirmware/esp32-c3/main/include \
  firmware/esp32-c3/main/src/multi_controller.c \
  firmware/esp32-c3/test/native_multi_controller.c \
  -o /tmp/multi-controller-test && /tmp/multi-controller-test
uv run --frozen python scripts/check_public_tree.py
```

CIでは3 OSのホストテストと、Linux上で両ファームウェアをビルドします。
リリースバイナリの公開前には、実機でペアリング、入力、振動、watchdogを確認します。

## 安全動作と制限

- ファームウェアはホスト入力が1.2秒途絶えるとキューを破棄してニュートラルへ戻します。
- ホストは操作ページ切断時にニュートラル状態を送ります。
- BLEキュー停止や通知失敗には時間制限付きの復旧処理があります。
- 3接続はESP32-C3の無線とメモリプールを共有します。コンソールやESP-IDFの更新後は
  必ず3台を同時に実機検証してください。1接続の成功だけでは3接続時のタイミング安定性を
  保証できません。
- 非標準の5 ms BLE間隔を利用するため、ESP32-C3対応は実験的です。

README用メディアは`docs/assets`へ置き、未圧縮動画はGitへコミットしません。

## ライセンス

プロジェクト独自コードはMIT Licenseです。上流ファームウェアとEspressifライブラリの
表記は[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を参照してください。
