import React from 'react';
import {Composition} from 'remotion';
import {Switch2RemoteControllerVideo} from './Video';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Switch2RemoteController"
    component={Switch2RemoteControllerVideo}
    durationInFrames={2250}
    fps={30}
    width={1920}
    height={1080}
  />
);
