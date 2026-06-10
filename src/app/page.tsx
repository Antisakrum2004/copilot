'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, MicOff, Send, Trash2, Bot, User, Sparkles, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

// SpeechRecognition types
interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent {
  error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
  }
}

export default function Home() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [aiResponse, setAiResponse] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [mode, setMode] = useState<'technical' | 'behavioral' | 'general'>('general');
  const [autoSend, setAutoSend] = useState(true);
  const [silenceTimeout, setSilenceTimeout] = useState<number | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSpeechTimeRef = useRef<number>(0);
  const accumulatedTextRef = useRef<string>('');

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, aiResponse, scrollToBottom]);

  const generateId = () => Math.random().toString(36).substring(2, 9);

  const sendToLLM = useCallback(async (question: string) => {
    if (!question.trim() || isGenerating) return;

    setIsGenerating(true);
    setAiResponse('');

    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: question.trim(),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);

    try {
      const context = messages.slice(-6).map(m => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          context,
          mode,
        }),
      });

      if (!response.ok) {
        throw new Error('API request failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                fullResponse += parsed.content;
                setAiResponse(fullResponse);
              }
            } catch {}
          }
        }
      }

      if (fullResponse) {
        const assistantMessage: Message = {
          id: generateId(),
          role: 'assistant',
          content: fullResponse,
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, assistantMessage]);
      }
    } catch (error) {
      console.error('LLM error:', error);
      const errorMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: 'Ошибка при генерации ответа. Попробуйте ещё раз.',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsGenerating(false);
      setAiResponse('');
    }
  }, [isGenerating, messages, mode]);

  // Silence detection: auto-send after 2s of no speech
  const resetSilenceTimer = useCallback((currentText: string) => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }

    if (!autoSend) return;

    silenceTimerRef.current = setTimeout(() => {
      const textToSend = currentText || accumulatedTextRef.current;
      if (textToSend.trim().length > 3) {
        sendToLLM(textToSend.trim());
        accumulatedTextRef.current = '';
        setTranscript('');
        setInterimTranscript('');
      }
    }, 2500);
  }, [autoSend, sendToLLM]);

  const startListening = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Ваш браузер не поддерживает распознавание речи. Используйте Chrome или Edge.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'ru-RU';

    let finalTranscript = '';

    recognition.onstart = () => {
      setIsListening(true);
      lastSpeechTimeRef.current = Date.now();
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let newFinal = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          newFinal += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (newFinal) {
        finalTranscript += newFinal;
        accumulatedTextRef.current = finalTranscript;
        setTranscript(finalTranscript);
        lastSpeechTimeRef.current = Date.now();
        resetSilenceTimer(finalTranscript);
      }

      setInterimTranscript(interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('Speech recognition error:', event.error);
      if (event.error === 'not-allowed') {
        alert('Доступ к микрофону запрещён. Разрешите доступ в настройках браузера.');
      }
    };

    recognition.onend = () => {
      // Restart if still supposed to be listening
      if (isListening || true) {
        try {
          recognition.start();
        } catch {
          setIsListening(false);
        }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [resetSilenceTimer]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    setIsListening(false);

    // If there's unsent text, send it
    const textToSend = transcript || accumulatedTextRef.current;
    if (autoSend && textToSend.trim().length > 3 && !isGenerating) {
      sendToLLM(textToSend.trim());
    }

    accumulatedTextRef.current = '';
  }, [transcript, autoSend, isGenerating, sendToLLM]);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  const handleManualSend = useCallback(() => {
    const text = transcript || accumulatedTextRef.current;
    if (text.trim()) {
      sendToLLM(text.trim());
      accumulatedTextRef.current = '';
      setTranscript('');
      setInterimTranscript('');
    }
  }, [transcript, sendToLLM]);

  const clearConversation = useCallback(() => {
    setMessages([]);
    setTranscript('');
    setInterimTranscript('');
    setAiResponse('');
    accumulatedTextRef.current = '';
  }, []);

  const formatTime = (date: Date) =>
    date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const modeLabels: Record<string, string> = {
    technical: 'Техническое',
    behavioral: 'Поведенческое',
    general: 'Общее',
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">AI Assistant</h1>
              <p className="text-xs text-slate-400">Слушаю и помогаю в реальном времени</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`text-xs ${
                isListening
                  ? 'border-emerald-500/50 text-emerald-400 bg-emerald-500/10'
                  : 'border-slate-600 text-slate-400'
              }`}
            >
              {isListening ? 'Слушаю...' : 'Остановлен'}
            </Badge>

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="text-slate-400 hover:text-white">
                  <Settings className="w-4 h-4" />
                </Button>
              </SheetTrigger>
              <SheetContent className="bg-slate-900 border-slate-800">
                <SheetHeader>
                  <SheetTitle className="text-white">Настройки</SheetTitle>
                </SheetHeader>
                <div className="mt-6 space-y-6">
                  <div className="space-y-2">
                    <Label className="text-slate-300">Режим интервью</Label>
                    <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                      <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-700">
                        <SelectItem value="general">Общее</SelectItem>
                        <SelectItem value="technical">Техническое</SelectItem>
                        <SelectItem value="behavioral">Поведенческое</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-slate-300">Автоотправка (2.5с пауза)</Label>
                    <Switch checked={autoSend} onCheckedChange={setAutoSend} />
                  </div>
                  <Separator className="bg-slate-700" />
                  <div className="text-xs text-slate-500 space-y-1">
                    <p>Используйте Chrome или Edge для лучшего распознавания речи.</p>
                    <p>Помощник позиционируется как открытый инструмент подготовки.</p>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-4 flex flex-col gap-4">
        {/* Live transcription area */}
        <Card className="bg-slate-900/60 border-slate-800/50 backdrop-blur-sm">
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-sm font-medium text-slate-400 flex items-center gap-2">
              <User className="w-4 h-4" />
              Собеседник говорит
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="min-h-[80px] max-h-[160px] overflow-y-auto rounded-lg bg-slate-800/50 p-3">
              {transcript || interimTranscript ? (
                <p className="text-base leading-relaxed">
                  <span className="text-white">{transcript}</span>
                  {interimTranscript && (
                    <span className="text-slate-400 italic">{interimTranscript}</span>
                  )}
                </p>
              ) : (
                <p className="text-slate-600 text-sm italic">
                  {isListening
                    ? 'Ожидание речи...'
                    : 'Нажмите кнопку "Слушать" для начала'}
                </p>
              )}
            </div>
            {transcript && (
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs border-slate-700 text-slate-300 hover:bg-slate-800"
                  onClick={handleManualSend}
                  disabled={isGenerating || !transcript.trim()}
                >
                  <Send className="w-3 h-3 mr-1" />
                  Отправить
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs text-slate-500 hover:text-slate-300"
                  onClick={() => {
                    setTranscript('');
                    setInterimTranscript('');
                    accumulatedTextRef.current = '';
                  }}
                >
                  Очистить
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Chat messages */}
        <Card className="flex-1 bg-slate-900/60 border-slate-800/50 backdrop-blur-sm flex flex-col min-h-0">
          <CardHeader className="pb-3 pt-4 px-4 shrink-0">
            <CardTitle className="text-sm font-medium text-slate-400 flex items-center gap-2">
              <Bot className="w-4 h-4" />
              Подсказки ИИ
              {isGenerating && (
                <Badge variant="outline" className="text-xs border-violet-500/50 text-violet-400 bg-violet-500/10 animate-pulse">
                  Генерация...
                </Badge>
              )}
              <Badge variant="outline" className="text-xs border-slate-700 text-slate-500 ml-auto">
                {modeLabels[mode]}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 flex-1 min-h-0">
            <ScrollArea className="h-[calc(100vh-420px)] min-h-[200px]">
              {messages.length === 0 && !aiResponse ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center py-12">
                  <div className="w-16 h-16 rounded-2xl bg-slate-800/50 flex items-center justify-center mb-4">
                    <Sparkles className="w-8 h-8 text-violet-400/50" />
                  </div>
                  <p className="text-slate-500 text-sm max-w-xs">
                    Нажмите «Слушать» и начните говорить. ИИ будет автоматически
                    генерировать подсказки после паузы.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex gap-3 ${
                        msg.role === 'user' ? 'justify-start' : 'justify-start'
                      }`}
                    >
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-1 ${
                          msg.role === 'user'
                            ? 'bg-slate-700'
                            : 'bg-gradient-to-br from-violet-500 to-purple-600'
                        }`}
                      >
                        {msg.role === 'user' ? (
                          <User className="w-3.5 h-3.5 text-slate-300" />
                        ) : (
                          <Bot className="w-3.5 h-3.5 text-white" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs text-slate-500">
                            {msg.role === 'user' ? 'Вопрос' : 'ИИ-подсказка'}
                          </span>
                          <span className="text-xs text-slate-600">
                            {formatTime(msg.timestamp)}
                          </span>
                        </div>
                        <div
                          className={`text-sm leading-relaxed rounded-lg p-3 ${
                            msg.role === 'user'
                              ? 'bg-slate-800/50 text-slate-300'
                              : 'bg-violet-500/10 border border-violet-500/20 text-slate-200'
                          }`}
                        >
                          <p className="whitespace-pre-wrap">{msg.content}</p>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Streaming AI response */}
                  {aiResponse && (
                    <div className="flex gap-3">
                      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shrink-0 mt-1">
                        <Bot className="w-3.5 h-3.5 text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs text-slate-500">ИИ-подсказка</span>
                          <span className="text-xs text-violet-400 animate-pulse">печатает...</span>
                        </div>
                        <div className="text-sm leading-relaxed rounded-lg p-3 bg-violet-500/10 border border-violet-500/20 text-slate-200">
                          <p className="whitespace-pre-wrap">{aiResponse}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </main>

      {/* Bottom control bar */}
      <footer className="sticky bottom-0 border-t border-slate-800/50 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="text-slate-500 hover:text-red-400"
            onClick={clearConversation}
            title="Очистить историю"
          >
            <Trash2 className="w-4 h-4" />
          </Button>

          <Button
            size="lg"
            className={`rounded-full px-8 h-12 text-base font-medium shadow-lg transition-all duration-300 ${
              isListening
                ? 'bg-red-600 hover:bg-red-700 shadow-red-600/30'
                : 'bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 shadow-violet-600/30'
            }`}
            onClick={toggleListening}
          >
            {isListening ? (
              <>
                <MicOff className="w-5 h-5 mr-2" />
                Стоп
              </>
            ) : (
              <>
                <Mic className="w-5 h-5 mr-2" />
                Слушать
              </>
            )}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="text-slate-500 hover:text-violet-400"
            onClick={handleManualSend}
            disabled={isGenerating || !transcript.trim()}
            title="Отправить вручную"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>

        {/* Animated pulse indicator when listening */}
        {isListening && (
          <div className="flex justify-center -mt-1 mb-1">
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse [animation-delay:0.2s]" />
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse [animation-delay:0.4s]" />
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}
