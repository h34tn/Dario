import { GlyphContext } from './screen.js';
import { Component, useEffect, useState, type ReactNode } from 'react';
import { Box, useInput } from 'ink';
import { LiveJob, type LiveJobProps } from './LiveJob.js';
import { FallbackPrompt, type FallbackPromptProps } from './FallbackPrompt.js';
import { PlanPrompt, type PlanPromptProps } from './PlanPrompt.js';

export class DisplayBoundary extends Component<{ children: ReactNode; onError: (error: Error) => void }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

interface RunAppProps extends Omit<LiveJobProps, 'now'> {
  prompt?: PlanPromptProps;
  ask?: Omit<FallbackPromptProps, 'symbols'>;
  inputEnabled: boolean;
  onInterrupt: () => void;
  onError: (error: Error) => void;
}

function JobScreen(props: RunAppProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') props.onInterrupt();
  }, { isActive: props.inputEnabled && ((!props.prompt && !props.ask) || !!props.suspended) });
  return <Box flexDirection="column">
    <LiveJob {...props} now={now} />
    {!props.suspended && props.prompt && <PlanPrompt {...props.prompt} />}
    {!props.suspended && props.ask && <FallbackPrompt {...props.ask} symbols={props.symbols} />}
  </Box>;
}

export function RunApp(props: RunAppProps) {
  return <GlyphContext.Provider value={props.symbols}>
    <DisplayBoundary onError={props.onError}><JobScreen {...props} /></DisplayBoundary>
  </GlyphContext.Provider>;
}
