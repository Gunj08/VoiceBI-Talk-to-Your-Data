
import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  BarChart3, 
  Database, 
  Mic, 
  MicOff, 
  MessageSquare, 
  Settings,
  TrendingUp,
  History,
  Info
} from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { generateMockData, DB_SCHEMA_DESCRIPTION } from './data/mockData';
import { BIResponse, Message, ChartDataPoint, ChartType } from './types';
import ChartRenderer from './components/ChartRenderer';

// Shared Audio Utilities
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [lastResponse, setLastResponse] = useState<BIResponse | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [status, setStatus] = useState<string>('Ready to analyze');
  const [isLoading, setIsLoading] = useState(false);
  const [mockData] = useState(() => generateMockData());

  // Audio Context References
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);

  const processResponse = (text: string) => {
    try {
      // Find JSON block in response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as BIResponse;
        setLastResponse(parsed);
        setHistory(prev => [{
          role: 'assistant',
          content: parsed.insight,
          timestamp: new Date()
        }, ...prev]);
        setStatus('Analysis complete');
      } else {
        setHistory(prev => [{
          role: 'assistant',
          content: text,
          timestamp: new Date()
        }, ...prev]);
      }
    } catch (e) {
      console.error("Failed to parse response", e);
    }
  };

  const startSession = async () => {
    if (sessionRef.current) return;

    setStatus('Connecting to AI...');
    setIsLoading(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            console.log('Session Opened');
            setStatus('Listening...');
            setIsRecording(true);
            setIsLoading(false);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Audio output processing
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            // Transcription/Text output processing
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              // We'll process the full text once turn is complete
            }

            if (message.serverContent?.turnComplete) {
              // Usually the model responds with text/audio simultaneously.
              // In this demo, we'll listen for final insights.
            }

            // Handle function calls if any (not used here for simplicity, we use system instruction)
          },
          onerror: (e) => {
            console.error('Session error', e);
            setStatus('Connection error');
            stopSession();
          },
          onclose: () => {
            console.log('Session closed');
            stopSession();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are a Senior BI Analyst with access to a sales database.
          DATABASE SCHEMA: ${DB_SCHEMA_DESCRIPTION}
          
          Your task:
          1. Listen to the user's natural language query.
          2. Perform mental data aggregation on the provided mock context (imagine the result).
          3. Respond verbally with a brief summary of the insight.
          4. ALWAYS include a JSON block in your internal text response that strictly follows the BIResponse interface:
          interface BIResponse {
            insight: string; (Brief text summary)
            data: {label: string, value: number}[]; (Aggregated data points)
            chartType: 'bar' | 'line' | 'area' | 'pie'; (Recommended visualization)
            title: string; (Concise title for the chart)
          }
          Return realistic numbers based on the query. For example, if asked for "last 7 days revenue", generate 7 data points with labels like "Oct 01".
          
          Speak naturally but include the data JSON in your final response buffer.`,
        }
      });

      sessionRef.current = await sessionPromise;

      // Microphone setup
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
      
      const source = inputAudioContextRef.current.createMediaStreamSource(stream);
      scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      scriptProcessorRef.current.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const l = inputData.length;
        const int16 = new Int16Array(l);
        for (let i = 0; i < l; i++) {
          int16[i] = inputData[i] * 32768;
        }
        const pcmBlob = {
          data: encode(new Uint8Array(int16.buffer)),
          mimeType: 'audio/pcm;rate=16000',
        };
        sessionRef.current?.sendRealtimeInput({ media: pcmBlob });
      };

      source.connect(scriptProcessorRef.current);
      scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);

    } catch (err) {
      console.error('Error starting session', err);
      setStatus('Microphone access denied');
      setIsLoading(false);
    }
  };

  const stopSession = () => {
    setIsRecording(false);
    setStatus('Analysis complete');
    
    scriptProcessorRef.current?.disconnect();
    inputAudioContextRef.current?.close();
    outputAudioContextRef.current?.close();
    
    sourcesRef.current.forEach(s => s.stop());
    sourcesRef.current.clear();
    
    sessionRef.current?.close();
    sessionRef.current = null;
    
    // Simulate parsing the last assistant message if it were text
    // In a real Live API setup, we'd collect transcription chunks.
    // For this prototype, we'll mock the final response processing if we had a full text string.
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopSession();
    } else {
      startSession();
    }
  };

  // Mock a query for initial load to show UI
  useEffect(() => {
    setLastResponse({
      title: "Quarterly Revenue Growth",
      insight: "Revenue has shown a steady 12% increase month-over-month, driven primarily by the Electronics category.",
      chartType: 'area',
      data: [
        { label: 'Jul', value: 4200 },
        { label: 'Aug', value: 4800 },
        { label: 'Sep', value: 5100 },
        { label: 'Oct', value: 5800 },
      ]
    });
  }, []);

  return (
    <div className="min-h-screen flex flex-col lg:flex-row overflow-hidden bg-slate-950 text-slate-200">
      {/* Sidebar */}
      <aside className="w-full lg:w-80 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0">
        <div className="p-6 border-b border-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Activity className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight">VoiceBI</h1>
            <p className="text-xs text-slate-500 uppercase font-semibold">Intelligence Engine</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest px-2 mb-2">Workspace</p>
          <button className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg bg-slate-800 text-blue-400">
            <TrendingUp size={18} /> Dashboard
          </button>
          <button className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:bg-slate-800 transition-colors">
            <Database size={18} /> Data Explorer
          </button>
          <button className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg text-slate-400 hover:bg-slate-800 transition-colors">
            <History size={18} /> Recent Queries
          </button>
          
          <div className="pt-8">
            <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest px-2 mb-2">History</p>
            {history.length === 0 ? (
              <div className="px-3 py-4 text-center rounded-xl bg-slate-950/50 border border-slate-800/50">
                <MessageSquare className="mx-auto mb-2 text-slate-700" size={20} />
                <p className="text-xs text-slate-600">No recent conversations</p>
              </div>
            ) : (
              <div className="space-y-3">
                {history.map((msg, idx) => (
                  <div key={idx} className={`p-3 rounded-xl border text-xs ${msg.role === 'user' ? 'bg-slate-950 border-slate-800' : 'bg-blue-900/10 border-blue-900/20 text-slate-300'}`}>
                    <p className="line-clamp-3">{msg.content}</p>
                    <span className="text-[10px] text-slate-600 mt-2 block">{msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-3">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/50 border border-slate-700/50">
            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold">JD</div>
            <div className="flex-1 overflow-hidden">
              <p className="text-sm font-medium truncate">Data Analyst</p>
              <p className="text-xs text-slate-500 truncate">Standard Plan</p>
            </div>
            <Settings size={16} className="text-slate-500" />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden h-screen">
        {/* Header */}
        <header className="h-16 flex items-center justify-between px-8 border-b border-slate-800 glass z-10 shrink-0">
          <div className="flex items-center gap-4">
             <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-green-500'}`}></div>
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{status}</span>
             </div>
          </div>
          <div className="flex items-center gap-3">
            <button className="p-2 text-slate-400 hover:text-white transition-colors"><Info size={20}/></button>
            <div className="h-4 w-px bg-slate-800"></div>
            <span className="text-xs font-mono bg-slate-800 px-2 py-1 rounded text-blue-400 border border-slate-700">GEMINI-FLASH-LIVE</span>
          </div>
        </header>

        {/* Dashboard Area */}
        <div className="flex-1 overflow-y-auto p-8 space-y-8 pb-32">
          {/* Metrics Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { label: 'Total Revenue', value: '$242.5k', change: '+12.5%', icon: TrendingUp, color: 'text-blue-500' },
              { label: 'Avg Sale Value', value: '$48.20', change: '+3.1%', icon: BarChart3, color: 'text-emerald-500' },
              { label: 'New Customers', value: '1,284', change: '+8.4%', icon: Activity, color: 'text-purple-500' },
              { label: 'Active Regions', value: '4', change: 'Stable', icon: Database, color: 'text-amber-500' },
            ].map((stat, i) => (
              <div key={i} className="p-6 rounded-2xl glass hover:border-slate-700 transition-all group">
                <div className="flex justify-between items-start mb-4">
                  <div className={`p-3 rounded-xl bg-slate-800/50 ${stat.color} group-hover:scale-110 transition-transform`}>
                    <stat.icon size={20} />
                  </div>
                  <span className={`text-xs font-bold px-2 py-1 rounded-full bg-slate-900 border border-slate-800 ${stat.change.includes('+') ? 'text-green-500' : 'text-slate-500'}`}>
                    {stat.change}
                  </span>
                </div>
                <h3 className="text-slate-400 text-xs font-medium uppercase tracking-wider">{stat.label}</h3>
                <p className="text-2xl font-bold mt-1">{stat.value}</p>
              </div>
            ))}
          </div>

          {/* Visualization Area */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
            <div className="xl:col-span-2 space-y-8">
              {lastResponse ? (
                <div className="p-8 rounded-3xl glass border-slate-800/50 shadow-2xl">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                    <div>
                      <h2 className="text-2xl font-bold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">{lastResponse.title}</h2>
                      <p className="text-slate-400 text-sm mt-1">{lastResponse.insight}</p>
                    </div>
                    <div className="flex items-center gap-2 bg-slate-900/50 p-1 rounded-xl border border-slate-800">
                      {(['bar', 'line', 'area', 'pie'] as ChartType[]).map(t => (
                        <button 
                          key={t}
                          onClick={() => setLastResponse({...lastResponse, chartType: t})}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${lastResponse.chartType === t ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  <div className="h-[400px] w-full chart-container">
                    <ChartRenderer type={lastResponse.chartType} data={lastResponse.data} />
                  </div>
                </div>
              ) : (
                <div className="h-[500px] rounded-3xl glass border-dashed border-slate-800 flex flex-col items-center justify-center text-center p-12">
                   <div className="w-20 h-20 rounded-full bg-slate-900 border border-slate-800 flex items-center justify-center mb-6">
                      <BarChart3 size={32} className="text-slate-700" />
                   </div>
                   <h3 className="text-xl font-bold mb-2">Ready to Visualize</h3>
                   <p className="text-slate-500 max-w-sm mb-8">Ask a question like "Show me sales by region for the last month" or "Compare electronics vs software revenue".</p>
                   <div className="flex flex-wrap justify-center gap-3">
                     {['Top regions', 'Monthly revenue', 'Customer split'].map(s => (
                       <span key={s} className="px-4 py-2 rounded-full bg-slate-900 border border-slate-800 text-xs text-slate-400">"{s}"</span>
                     ))}
                   </div>
                </div>
              )}

              {/* Data Preview Table */}
              <div className="p-6 rounded-3xl glass overflow-hidden">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="font-bold flex items-center gap-2"><Database size={18} className="text-blue-500" /> Recent Transactions</h3>
                  <button className="text-xs text-blue-400 hover:underline">View All Source Data</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-800">
                        <th className="pb-4 font-semibold text-slate-400">ID</th>
                        <th className="pb-4 font-semibold text-slate-400">Date</th>
                        <th className="pb-4 font-semibold text-slate-400">Category</th>
                        <th className="pb-4 font-semibold text-slate-400">Region</th>
                        <th className="pb-4 font-semibold text-slate-400 text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-900">
                      {mockData.slice(0, 5).map((row) => (
                        <tr key={row.id} className="hover:bg-white/5 transition-colors">
                          <td className="py-4 font-mono text-xs text-slate-500">{row.id}</td>
                          <td className="py-4">{row.date}</td>
                          <td className="py-4">
                            <span className="px-2 py-1 rounded-md bg-slate-800 text-[10px] font-bold uppercase tracking-wide">{row.category}</span>
                          </td>
                          <td className="py-4 text-slate-400">{row.region}</td>
                          <td className="py-4 text-right font-medium text-white">${row.revenue.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="space-y-8">
              <div className="p-6 rounded-3xl glass border-slate-800/50">
                 <h3 className="font-bold mb-4 flex items-center gap-2"><Info size={18} className="text-amber-500" /> Analytics Summary</h3>
                 <div className="space-y-4">
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Current dataset contains over 500 records spanning the last 90 days. Revenue distribution is skewed towards North America (34%) and Europe (28%).
                    </p>
                    <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                      <p className="text-xs font-medium text-amber-200">Insight Alert</p>
                      <p className="text-[11px] text-amber-300/70 mt-1">Growth in the "Software" category has accelerated by 18% since last Monday. Recommend increasing ad spend in Asia Pacific.</p>
                    </div>
                 </div>
              </div>

              <div className="p-6 rounded-3xl glass border-slate-800/50">
                <h3 className="font-bold mb-4">Sample Questions</h3>
                <div className="space-y-2">
                  {[
                    "What's the revenue by category?",
                    "Show me sales trends for last 30 days",
                    "Which region has the highest growth?",
                    "Compare new vs returning customers",
                    "What's the total units sold this week?"
                  ].map(q => (
                    <button key={q} className="w-full text-left p-3 rounded-xl hover:bg-white/5 border border-transparent hover:border-slate-800 transition-all text-xs text-slate-400">
                      "{q}"
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Voice Control Floating Bar */}
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-50">
          <div className="glass shadow-2xl rounded-full p-2 flex items-center gap-4 pr-6 pl-2 border-slate-700/50">
            <button
              onClick={toggleRecording}
              disabled={isLoading}
              className={`relative w-16 h-16 rounded-full flex items-center justify-center transition-all ${
                isRecording 
                  ? 'bg-red-500 shadow-lg shadow-red-500/40 animate-pulse' 
                  : 'bg-blue-600 shadow-lg shadow-blue-500/40 hover:scale-105'
              } disabled:opacity-50`}
            >
              {isRecording ? <MicOff size={28} className="text-white" /> : <Mic size={28} className="text-white" />}
              {isRecording && (
                <div className="absolute -inset-1 border-2 border-red-500/50 rounded-full animate-ping"></div>
              )}
            </button>
            <div className="flex flex-col">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-widest">
                {isLoading ? 'Processing...' : isRecording ? 'Listening Now' : 'Voice Assistant'}
              </span>
              <span className="text-[10px] text-slate-500 italic">
                {isRecording ? 'Speak your query clearly...' : 'Tap to start voice inquiry'}
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
