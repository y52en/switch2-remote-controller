import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const C = {
  bg: '#090b10',
  panel: '#111722',
  panel2: '#171f2d',
  text: '#f4f7fb',
  muted: '#9aa8ba',
  cyan: '#45d7ff',
  blue: '#4587ff',
  green: '#67e8a5',
  red: '#ff647c',
  yellow: '#ffd166',
  line: '#2b3547',
};

const font = 'Inter, "Noto Sans JP", "Yu Gothic UI", "Meiryo", sans-serif';

const fade = (frame: number, duration: number) =>
  interpolate(frame, [0, 15, duration - 15, duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

const Background: React.FC<{children: React.ReactNode}> = ({children}) => (
  <AbsoluteFill
    style={{
      fontFamily: font,
      color: C.text,
      background:
        'radial-gradient(circle at 50% -15%, #26344d 0%, #111722 30%, #090b10 68%)',
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        position: 'absolute',
        inset: 0,
        opacity: 0.16,
        backgroundImage:
          'linear-gradient(#ffffff12 1px, transparent 1px), linear-gradient(90deg, #ffffff12 1px, transparent 1px)',
        backgroundSize: '64px 64px',
      }}
    />
    {children}
  </AbsoluteFill>
);

const Label: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div
    style={{
      color: C.cyan,
      fontWeight: 800,
      fontSize: 26,
      letterSpacing: 5,
      textTransform: 'uppercase',
    }}
  >
    {children}
  </div>
);

const Title: React.FC<{children: React.ReactNode; size?: number}> = ({
  children,
  size = 72,
}) => (
  <div style={{fontWeight: 900, fontSize: size, lineHeight: 1.12, letterSpacing: -2}}>
    {children}
  </div>
);

const Caption: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div
    style={{
      position: 'absolute',
      left: 120,
      right: 120,
      bottom: 52,
      padding: '18px 28px',
      borderRadius: 18,
      background: '#06080dbb',
      border: `1px solid ${C.line}`,
      textAlign: 'center',
      fontSize: 32,
      fontWeight: 750,
      boxShadow: '0 18px 50px #0008',
    }}
  >
    {children}
  </div>
);

const PulseDot: React.FC<{color?: string}> = ({color = C.green}) => {
  const frame = useCurrentFrame();
  const pulse = 0.65 + Math.sin(frame / 7) * 0.18;
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: 999,
        background: color,
        boxShadow: `0 0 ${18 * pulse}px ${color}`,
        display: 'inline-block',
      }}
    />
  );
};

const ControllerButton: React.FC<{
  children: React.ReactNode;
  active?: boolean;
  round?: boolean;
}> = ({children, active = false, round = false}) => (
  <div
    style={{
      width: round ? 86 : 104,
      height: round ? 86 : 58,
      borderRadius: round ? 999 : 18,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 28,
      fontWeight: 900,
      background: active
        ? `linear-gradient(145deg, ${C.cyan}, ${C.blue})`
        : 'linear-gradient(145deg, #303b4e, #171e2a)',
      border: `2px solid ${active ? '#9bedff' : '#445067'}`,
      boxShadow: active ? '0 0 38px #45d7ff88' : '0 10px 22px #0006',
      transform: active ? 'scale(0.93)' : 'scale(1)',
    }}
  >
    {children}
  </div>
);

const Stick: React.FC<{active?: boolean; direction?: 'left' | 'right'}> = ({
  active = false,
  direction = 'right',
}) => (
  <div
    style={{
      width: 160,
      height: 160,
      borderRadius: 999,
      border: `14px solid ${C.line}`,
      background: '#080b11',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: 'inset 0 10px 25px #000b, 0 16px 30px #0007',
    }}
  >
    <div
      style={{
        width: 92,
        height: 92,
        borderRadius: 999,
        background: 'radial-gradient(circle at 35% 30%, #4d5b72, #202836)',
        border: '3px solid #65728a',
        transform: active ? `translateX(${direction === 'right' ? 28 : -28}px)` : undefined,
        boxShadow: active ? '0 0 28px #45d7ff88' : undefined,
      }}
    />
  </div>
);

const ControllerUI: React.FC<{compact?: boolean}> = ({compact = false}) => {
  const frame = useCurrentFrame();
  const cycle = frame % 150;
  const a = cycle > 22 && cycle < 45;
  const right = cycle > 55 && cycle < 100;
  const r = cycle > 108 && cycle < 132;

  return (
    <div
      style={{
        width: compact ? 720 : 900,
        padding: compact ? 30 : 40,
        borderRadius: 34,
        background: 'linear-gradient(160deg, #182130, #0d121b)',
        border: `1px solid ${C.line}`,
        boxShadow: '0 38px 90px #0009',
      }}
    >
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
        <div>
          <div style={{fontSize: 17, color: C.cyan, letterSpacing: 3, fontWeight: 800}}>
            ESP32-C3 / SWITCH 2
          </div>
          <div style={{fontSize: compact ? 30 : 38, fontWeight: 900}}>Remote Controller</div>
        </div>
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            color: C.green,
            fontWeight: 800,
            fontSize: 20,
          }}
        >
          <PulseDot /> 接続済み
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 10,
          marginTop: 24,
        }}
      >
        {[
          ['ブラウザ', '接続済み'],
          ['ESP32', '接続済み'],
          ['PC→ESP32', '2.8 ms'],
          ['BLE間隔', '5.0 ms'],
        ].map(([k, v]) => (
          <div key={k} style={{background: '#0a0e15', padding: '12px 14px', borderRadius: 14}}>
            <div style={{color: C.muted, fontSize: 14}}>{k}</div>
            <div style={{fontWeight: 850, fontSize: 19}}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{display: 'flex', justifyContent: 'space-between', marginTop: 30}}>
        <ControllerButton active={r}>L</ControllerButton>
        <ControllerButton>ZL</ControllerButton>
        <ControllerButton>ZR</ControllerButton>
        <ControllerButton active={r}>R</ControllerButton>
      </div>
      <div style={{display: 'flex', justifyContent: 'space-around', alignItems: 'center', marginTop: 30}}>
        <Stick />
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 86px)', gap: 8}}>
          <div />
          <ControllerButton round>X</ControllerButton>
          <div />
          <ControllerButton round>Y</ControllerButton>
          <ControllerButton round active={a}>A</ControllerButton>
          <ControllerButton round>B</ControllerButton>
        </div>
      </div>
      <div style={{display: 'flex', justifyContent: 'space-around', alignItems: 'center', marginTop: 24}}>
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 62px)', gap: 6}}>
          <div />
          <ControllerButton>▲</ControllerButton>
          <div />
          <ControllerButton>◀</ControllerButton>
          <div />
          <ControllerButton>▶</ControllerButton>
          <div />
          <ControllerButton>▼</ControllerButton>
          <div />
        </div>
        <Stick active={right} />
      </div>
    </div>
  );
};

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const scale = spring({frame, fps, config: {damping: 14, stiffness: 90}});
  const glow = interpolate(frame, [0, 80], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <Background>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center'}}>
        <div style={{transform: `scale(${0.84 + scale * 0.16})`, opacity: fade(frame, 180)}}>
          <Label>ESP32-C3 × WebRTC</Label>
          <div style={{marginTop: 24}}>
            <Title size={92}>Switch 2を<br />ブラウザから遠隔操作</Title>
          </div>
          <div
            style={{
              margin: '36px auto 0',
              fontSize: 32,
              color: C.muted,
              maxWidth: 1100,
              lineHeight: 1.6,
            }}
          >
            スマホやPCの入力を、ESP32-C3経由で低遅延に届ける<br />実験的なリモートコントローラー
          </div>
          <div
            style={{
              width: 420,
              height: 6,
              margin: '44px auto 0',
              borderRadius: 999,
              background: `linear-gradient(90deg, transparent, ${C.cyan}, transparent)`,
              opacity: glow,
              boxShadow: `0 0 34px ${C.cyan}`,
            }}
          />
        </div>
      </AbsoluteFill>
    </Background>
  );
};

const Demo: React.FC = () => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 35], [80, 0], {easing: Easing.out(Easing.cubic), extrapolateRight: 'clamp'});
  return (
    <Background>
      <div style={{padding: '58px 90px', opacity: fade(frame, 540)}}>
        <Label>DEMO</Label>
        <Title size={62}>離れた場所から、いつもの操作感で</Title>
        <div style={{display: 'flex', gap: 45, alignItems: 'center', marginTop: 48}}>
          <div style={{transform: `translateX(${-enter}px) scale(.83)`, transformOrigin: 'left center'}}>
            <ControllerUI />
          </div>
          <div style={{flex: 1, display: 'flex', flexDirection: 'column', gap: 22}}>
            {[
              ['①', 'ブラウザで入力', 'タッチ・キーボード・ゲームパッド'],
              ['②', 'WebRTCで直接送信', '通常の入力はブラウザ間をP2P転送'],
              ['③', 'ESP32-C3からBLE接続', 'Switch 2にはコントローラーとして見える'],
            ].map(([num, title, body], i) => {
              const shown = spring({frame: frame - i * 18, fps: 30, config: {damping: 16}});
              return (
                <div
                  key={title}
                  style={{
                    opacity: shown,
                    transform: `translateX(${(1 - shown) * 80}px)`,
                    padding: '24px 26px',
                    background: C.panel,
                    border: `1px solid ${C.line}`,
                    borderRadius: 22,
                  }}
                >
                  <div style={{display: 'flex', gap: 18, alignItems: 'center'}}>
                    <div style={{fontSize: 34, color: C.cyan, fontWeight: 900}}>{num}</div>
                    <div>
                      <div style={{fontSize: 28, fontWeight: 900}}>{title}</div>
                      <div style={{fontSize: 19, color: C.muted, marginTop: 4}}>{body}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <Caption>入力が止まると自動でニュートラルへ戻る、安全設計</Caption>
    </Background>
  );
};

const Architecture: React.FC = () => {
  const frame = useCurrentFrame();
  const items = [
    ['REMOTE', 'スマホ / PC', 'Browser'],
    ['P2P', 'WebRTC', 'DataChannel'],
    ['HOST', 'Node.js', 'Local bridge'],
    ['USB', 'ESP32-C3', 'Serial/JTAG'],
    ['BLE', 'Switch 2', 'Controller'],
  ];
  return (
    <Background>
      <div style={{padding: '68px 90px', opacity: fade(frame, 300)}}>
        <Label>HOW IT WORKS</Label>
        <Title size={64}>入力が届くまで</Title>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 110}}>
          {items.map(([tag, name, sub], i) => {
            const s = spring({frame: frame - i * 14, fps: 30, config: {damping: 15}});
            return (
              <React.Fragment key={tag}>
                <div
                  style={{
                    width: 260,
                    height: 220,
                    borderRadius: 30,
                    border: `1px solid ${C.line}`,
                    background: 'linear-gradient(160deg, #1a2332, #0c1119)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: s,
                    transform: `scale(${0.75 + s * 0.25})`,
                    boxShadow: i === 1 ? '0 0 55px #45d7ff33' : '0 28px 60px #0008',
                  }}
                >
                  <div style={{fontSize: 18, letterSpacing: 3, color: i === 1 ? C.cyan : C.muted, fontWeight: 900}}>{tag}</div>
                  <div style={{fontSize: 31, fontWeight: 900, marginTop: 14}}>{name}</div>
                  <div style={{fontSize: 19, color: C.muted, marginTop: 7}}>{sub}</div>
                </div>
                {i < items.length - 1 ? (
                  <div style={{width: 82, height: 4, background: `linear-gradient(90deg, ${C.blue}, ${C.cyan})`, boxShadow: '0 0 18px #45d7ff88'}} />
                ) : null}
              </React.Fragment>
            );
          })}
        </div>
      </div>
      <Caption>Cloudflare Workerは接続確立を担当。通常の操作データはP2Pで流れます</Caption>
    </Background>
  );
};

const Terminal: React.FC<{lines: string[]}> = ({lines}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        background: '#070a0f',
        border: `1px solid ${C.line}`,
        borderRadius: 22,
        padding: 26,
        minHeight: 300,
        fontFamily: 'Consolas, "SFMono-Regular", monospace',
        fontSize: 23,
        lineHeight: 1.75,
        boxShadow: '0 30px 70px #0008',
      }}
    >
      <div style={{display: 'flex', gap: 9, marginBottom: 18}}>
        <div style={{width: 13, height: 13, borderRadius: 20, background: C.red}} />
        <div style={{width: 13, height: 13, borderRadius: 20, background: C.yellow}} />
        <div style={{width: 13, height: 13, borderRadius: 20, background: C.green}} />
      </div>
      {lines.map((line, i) => {
        const visible = frame > i * 22;
        return (
          <div key={line} style={{opacity: visible ? 1 : 0, color: line.startsWith('$') ? C.cyan : C.text}}>
            {line}
          </div>
        );
      })}
    </div>
  );
};

const Step: React.FC<{
  number: string;
  title: string;
  detail: string;
  children: React.ReactNode;
  duration: number;
}> = ({number, title, detail, children, duration}) => {
  const frame = useCurrentFrame();
  const inAnim = spring({frame, fps: 30, config: {damping: 16}});
  return (
    <Background>
      <div style={{padding: '68px 90px', opacity: fade(frame, duration)}}>
        <div style={{display: 'flex', gap: 30, alignItems: 'center'}}>
          <div
            style={{
              width: 82,
              height: 82,
              borderRadius: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(145deg, ${C.cyan}, ${C.blue})`,
              fontSize: 42,
              fontWeight: 950,
              boxShadow: '0 0 45px #45d7ff55',
            }}
          >
            {number}
          </div>
          <div>
            <Label>SETUP</Label>
            <Title size={58}>{title}</Title>
          </div>
        </div>
        <div style={{fontSize: 27, color: C.muted, marginTop: 24}}>{detail}</div>
        <div style={{marginTop: 48, opacity: inAnim, transform: `translateY(${(1 - inAnim) * 40}px)`}}>{children}</div>
      </div>
    </Background>
  );
};

const PairingVisual: React.FC = () => {
  const frame = useCurrentFrame();
  const connected = frame > 95;
  return (
    <div style={{display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 70}}>
      <div style={{width: 430, height: 260, borderRadius: 38, background: C.panel, border: `2px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40, fontWeight: 900}}>
        Nintendo Switch 2
      </div>
      <div style={{width: 180, textAlign: 'center'}}>
        <div style={{height: 5, background: connected ? C.green : C.cyan, boxShadow: `0 0 24px ${connected ? C.green : C.cyan}`}} />
        <div style={{marginTop: 20, fontSize: 22, color: connected ? C.green : C.cyan, fontWeight: 800}}>
          {connected ? '登録完了' : 'L + R'}
        </div>
      </div>
      <div style={{width: 360, height: 260, borderRadius: 38, background: C.panel, border: `2px solid ${connected ? C.green : C.line}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'}}>
        <div style={{fontSize: 31, fontWeight: 900}}>ESP32-C3</div>
        <div style={{fontSize: 22, color: C.muted, marginTop: 16}}>BLE Controller</div>
        <div style={{display: 'flex', gap: 20, marginTop: 25}}><ControllerButton active={!connected}>L</ControllerButton><ControllerButton active={!connected}>R</ControllerButton></div>
      </div>
    </div>
  );
};

const RemoteSession: React.FC = () => {
  const frame = useCurrentFrame();
  const issued = frame > 75;
  return (
    <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 44}}>
      <div style={{padding: 34, borderRadius: 28, background: C.panel, border: `1px solid ${C.line}`}}>
        <div style={{fontSize: 31, fontWeight: 900}}>Web遠隔操作</div>
        <div style={{marginTop: 28, color: C.muted, fontSize: 20}}>Cloudflare Worker URL</div>
        <div style={{marginTop: 9, padding: 16, borderRadius: 14, background: '#080b10', fontSize: 19}}>https://switch2-remote.example.workers.dev</div>
        <div style={{marginTop: 24, padding: 17, width: 230, borderRadius: 15, textAlign: 'center', fontSize: 22, fontWeight: 900, background: `linear-gradient(145deg, ${C.cyan}, ${C.blue})`, transform: issued ? 'scale(.96)' : undefined}}>セッション発行</div>
      </div>
      <div style={{padding: 34, borderRadius: 28, background: C.panel, border: `1px solid ${issued ? C.green : C.line}`, opacity: issued ? 1 : .45}}>
        <div style={{color: C.green, fontSize: 22, fontWeight: 900}}>共有URLを発行しました</div>
        <div style={{fontSize: 30, marginTop: 22, fontWeight: 900}}>ROOM: 7K4M9Q</div>
        <div style={{marginTop: 20, padding: 16, borderRadius: 14, background: '#080b10', color: C.cyan, fontSize: 18}}>https://example.workers.dev/?room=7K4M9Q</div>
        <div style={{marginTop: 22, color: C.muted, fontSize: 19}}>URLを相手に送るだけで参加できます</div>
      </div>
    </div>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const s = spring({frame, fps: 30, config: {damping: 14}});
  return (
    <Background>
      <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', textAlign: 'center'}}>
        <div style={{opacity: fade(frame, 210), transform: `scale(${0.88 + s * 0.12})`}}>
          <Label>OPEN SOURCE / EXPERIMENTAL</Label>
          <div style={{marginTop: 22}}><Title size={82}>Switch 2 Remote Controller</Title></div>
          <div style={{fontSize: 31, color: C.muted, marginTop: 30}}>セットアップ方法・ソースコードはGitHubで公開中</div>
          <div style={{fontSize: 34, fontWeight: 900, marginTop: 38, color: C.cyan}}>github.com/y52en/switch2-remote-controller</div>
          <div style={{fontSize: 20, color: C.muted, marginTop: 45}}>非公式コミュニティプロジェクト / Nintendoとは無関係です</div>
        </div>
      </AbsoluteFill>
    </Background>
  );
};

export const Switch2RemoteControllerVideo: React.FC = () => (
  <AbsoluteFill style={{backgroundColor: C.bg}}>
    <Sequence from={0} durationInFrames={180}><Intro /></Sequence>
    <Sequence from={180} durationInFrames={540}><Demo /></Sequence>
    <Sequence from={720} durationInFrames={300}><Architecture /></Sequence>
    <Sequence from={1020} durationInFrames={300}>
      <Step number="1" title="ESP32-C3へ書き込む" detail="headless版またはLCD版を選び、USBポートを指定します" duration={300}>
        <Terminal lines={[
          '$ uv sync --frozen',
          '$ uv run --frozen python scripts/firmware.py build --profile headless',
          '$ uv run --frozen python scripts/firmware.py upload --profile headless --port COM3',
          'ESP32-C3 verified ✓',
          'Upload complete ✓',
        ]} />
      </Step>
    </Sequence>
    <Sequence from={1320} durationInFrames={270}>
      <Step number="2" title="ホストアプリを起動" detail="シリアルポートを設定し、ローカルの操作画面を開きます" duration={270}>
        <div style={{display: 'grid', gridTemplateColumns: '.9fr 1.1fr', gap: 42}}>
          <Terminal lines={[
            '$ npm ci',
            '$ cp apps/host/.env.example apps/host/.env',
            'ESP32_SERIAL_PORT=COM3',
            '$ npm run start:host',
            'http://127.0.0.1:8787',
          ]} />
          <div style={{transform: 'scale(.62)', transformOrigin: 'top left', width: 900}}><ControllerUI compact /></div>
        </div>
      </Step>
    </Sequence>
    <Sequence from={1590} durationInFrames={240}>
      <Step number="3" title="Switch 2とペアリング" detail="Switch 2の登録画面で、画面上または割り当て済みのLとRを押します" duration={240}>
        <PairingVisual />
      </Step>
    </Sequence>
    <Sequence from={1830} durationInFrames={270}>
      <Step number="4" title="共有URLを発行" detail="Worker URLを指定してセッションを作成。操作権はホスト側で管理できます" duration={270}>
        <RemoteSession />
      </Step>
    </Sequence>
    <Sequence from={2100} durationInFrames={150}><Outro /></Sequence>
  </AbsoluteFill>
);
