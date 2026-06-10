#!/usr/bin/env python3
"""ShadowHint Analysis Report - PDF Generation"""

import os, sys, hashlib, subprocess

# ─── Palette ───
from reportlab.lib import colors
ACCENT       = colors.HexColor('#4e26c7')
TEXT_PRIMARY  = colors.HexColor('#212324')
TEXT_MUTED    = colors.HexColor('#72797e')
BG_SURFACE   = colors.HexColor('#dee4e7')
BG_PAGE      = colors.HexColor('#edf0f1')
TABLE_HEADER_COLOR = ACCENT
TABLE_HEADER_TEXT  = colors.white
TABLE_ROW_EVEN     = colors.white
TABLE_ROW_ODD     = BG_SURFACE

# ─── Fonts ───
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily

pdfmetrics.registerFont(TTFont('NotoSerifSC', '/usr/share/fonts/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSerifSCBold', '/usr/share/fonts/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('SarasaMonoSC', '/usr/share/fonts/truetype/chinese/SarasaMonoSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('SarasaMonoSCBold', '/usr/share/fonts/truetype/chinese/SarasaMonoSC-Bold.ttf'))
pdfmetrics.registerFont(TTFont('Tinos', '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'))
pdfmetrics.registerFont(TTFont('TinosBold', '/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf'))
pdfmetrics.registerFont(TTFont('Carlito', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'))
pdfmetrics.registerFont(TTFont('CarlitoBold', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'))
pdfmetrics.registerFont(TTFont('DejaVuSans', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'))

registerFontFamily('NotoSerifSC', normal='NotoSerifSC', bold='NotoSerifSCBold')
registerFontFamily('SarasaMonoSC', normal='SarasaMonoSC', bold='SarasaMonoSCBold')
registerFontFamily('Tinos', normal='Tinos', bold='TinosBold')
registerFontFamily('Carlito', normal='Carlito', bold='CarlitoBold')
registerFontFamily('DejaVuSans', normal='DejaVuSans', bold='DejaVuSans')

# Font fallback for mixed CJK/Latin
PDF_SKILL_DIR = '/home/z/my-project/skills/pdf'
_scripts = os.path.join(PDF_SKILL_DIR, 'scripts')
if _scripts not in sys.path:
    sys.path.insert(0, _scripts)
from pdf import install_font_fallback
install_font_fallback()

# ─── ReportLab Imports ───
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch, cm, mm
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, CondPageBreak, Image
)
from reportlab.platypus.tableofcontents import TableOfContents

# ─── Styles ───
BODY_FONT = 'NotoSerifSC'
HEADING_FONT = 'SarasaMonoSCBold'
EN_FONT = 'Tinos'

styles = getSampleStyleSheet()

style_h1 = ParagraphStyle(
    'H1_RU', fontName='SarasaMonoSCBold', fontSize=20, leading=28,
    textColor=ACCENT, spaceBefore=18, spaceAfter=10, wordWrap='CJK'
)
style_h2 = ParagraphStyle(
    'H2_RU', fontName='SarasaMonoSCBold', fontSize=15, leading=22,
    textColor=TEXT_PRIMARY, spaceBefore=14, spaceAfter=8, wordWrap='CJK'
)
style_h3 = ParagraphStyle(
    'H3_RU', fontName='SarasaMonoSCBold', fontSize=12, leading=18,
    textColor=TEXT_PRIMARY, spaceBefore=10, spaceAfter=6, wordWrap='CJK'
)
style_body = ParagraphStyle(
    'Body_RU', fontName=BODY_FONT, fontSize=10.5, leading=18,
    textColor=TEXT_PRIMARY, alignment=TA_LEFT, wordWrap='CJK',
    spaceBefore=0, spaceAfter=6
)
style_bullet = ParagraphStyle(
    'Bullet_RU', fontName=BODY_FONT, fontSize=10.5, leading=18,
    textColor=TEXT_PRIMARY, alignment=TA_LEFT, wordWrap='CJK',
    leftIndent=24, spaceBefore=2, spaceAfter=4
)
style_callout = ParagraphStyle(
    'Callout_RU', fontName=BODY_FONT, fontSize=10.5, leading=18,
    textColor=ACCENT, alignment=TA_LEFT, wordWrap='CJK',
    leftIndent=12, borderPadding=8, spaceBefore=6, spaceAfter=6
)
style_table_header = ParagraphStyle(
    'TH_RU', fontName=BODY_FONT, fontSize=10, leading=14,
    textColor=colors.white, alignment=TA_CENTER, wordWrap='CJK'
)
style_table_cell = ParagraphStyle(
    'TC_RU', fontName=BODY_FONT, fontSize=9.5, leading=14,
    textColor=TEXT_PRIMARY, alignment=TA_LEFT, wordWrap='CJK'
)
style_table_cell_c = ParagraphStyle(
    'TC_C_RU', fontName=BODY_FONT, fontSize=9.5, leading=14,
    textColor=TEXT_PRIMARY, alignment=TA_CENTER, wordWrap='CJK'
)
style_caption = ParagraphStyle(
    'Caption_RU', fontName=BODY_FONT, fontSize=9, leading=14,
    textColor=TEXT_MUTED, alignment=TA_CENTER, wordWrap='CJK',
    spaceBefore=3, spaceAfter=6
)

# ─── TOC Document Template ───
class TocDocTemplate(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if hasattr(flowable, 'bookmark_name'):
            level = getattr(flowable, 'bookmark_level', 0)
            text = getattr(flowable, 'bookmark_text', '')
            key = getattr(flowable, 'bookmark_key', '')
            self.notify('TOCEntry', (level, text, self.page, key))

# ─── Heading Helpers ───
def add_heading(text, style, level=0):
    key = 'h_%s' % hashlib.md5(text.encode()).hexdigest()[:8]
    p = Paragraph('<a name="%s"/>%s' % (key, text), style)
    p.bookmark_name = text
    p.bookmark_level = level
    p.bookmark_text = text
    p.bookmark_key = key
    return p

PAGE_W, PAGE_H = A4
L_MARGIN = 1.0 * inch
R_MARGIN = 1.0 * inch
T_MARGIN = 0.8 * inch
B_MARGIN = 0.8 * inch
AVAILABLE_W = PAGE_W - L_MARGIN - R_MARGIN
H1_ORPHAN_THRESHOLD = (PAGE_H - T_MARGIN - B_MARGIN) * 0.15

def add_major_section(text, style):
    return [
        CondPageBreak(H1_ORPHAN_THRESHOLD),
        add_heading(text, style, level=0),
    ]

# ─── Safe KeepTogether ───
MAX_KEEP_HEIGHT = PAGE_H * 0.4
def safe_keep_together(elements):
    total_h = 0
    for el in elements:
        w, h = el.wrap(AVAILABLE_W, PAGE_H)
        total_h += h
    if total_h <= MAX_KEEP_HEIGHT:
        return [KeepTogether(elements)]
    elif len(elements) >= 2:
        return [KeepTogether(elements[:2])] + list(elements[2:])
    else:
        return list(elements)

# ─── Table builder helper ───
def make_table(headers, rows, col_ratios=None):
    if col_ratios is None:
        col_ratios = [1.0 / len(headers)] * len(headers)
    col_widths = [r * AVAILABLE_W for r in col_ratios]
    
    data = [[Paragraph('<b>%s</b>' % h, style_table_header) for h in headers]]
    for row in rows:
        data.append([Paragraph(str(c), style_table_cell) if not isinstance(c, Paragraph) else c for c in row])
    
    t = Table(data, colWidths=col_widths, hAlign='CENTER')
    style_cmds = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER_COLOR),
        ('TEXTCOLOR', (0, 0), (-1, 0), TABLE_HEADER_TEXT),
        ('GRID', (0, 0), (-1, -1), 0.5, TEXT_MUTED),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]
    for i in range(1, len(data)):
        bg = TABLE_ROW_EVEN if i % 2 == 1 else TABLE_ROW_ODD
        style_cmds.append(('BACKGROUND', (0, i), (-1, i), bg))
    t.setStyle(TableStyle(style_cmds))
    return t

# ═══════════════════════════════════════════════════════════
#  BUILD DOCUMENT
# ═══════════════════════════════════════════════════════════

OUTPUT_BODY = '/home/z/my-project/download/shadowhint_body.pdf'

doc = TocDocTemplate(
    OUTPUT_BODY,
    pagesize=A4,
    leftMargin=L_MARGIN,
    rightMargin=R_MARGIN,
    topMargin=T_MARGIN,
    bottomMargin=B_MARGIN
)

story = []

# ─── TOC ───
toc = TableOfContents()
toc.levelStyles = [
    ParagraphStyle('TOC1', fontName=BODY_FONT, fontSize=13, leading=22, leftIndent=20, spaceBefore=6, wordWrap='CJK'),
    ParagraphStyle('TOC2', fontName=BODY_FONT, fontSize=11, leading=18, leftIndent=40, spaceBefore=3, wordWrap='CJK'),
]
story.append(Paragraph('<b>Содержание</b>', ParagraphStyle('TOCTitle', fontName=HEADING_FONT, fontSize=22, leading=30, textColor=ACCENT, alignment=TA_CENTER, spaceBefore=40, spaceAfter=20)))
story.append(toc)
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════
# SECTION 1: Overview
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Что такое ShadowHint', style_h1))

story.append(Paragraph(
    'ShadowHint - это десктопное приложение для Windows и macOS, позиционируемое как "скрытый ИИ-ассистент для собеседований". Его главная задача - помогать кандидатам проходить технические и другие виды собеседований, предоставляя подсказки в реальном времени. Приложение слушает вопросы интервьюера через микрофон, распознаёт речь, анализирует контекст и мгновенно генерирует структурированные ответы, которые отображаются на экране пользователя незаметно для собеседника.',
    style_body
))
story.append(Paragraph(
    'Проект является русскоязычным и ориентирован преимущественно на рынок СНГ. Сайт выполнен на Next.js с тёмной цветовой схемой, фиолетовыми акцентами и современным дизайном. ShadowHint активно продвигается через Telegram-канал, Яндекс.Метрику и реферальную программу, предлагая пользователям как бесплатную версию с ограничениями, так и платную подписку с полным функционалом.',
    style_body
))
story.append(Paragraph(
    'По заявлению разработчиков, ассистент способен формировать подсказки за 236 миллисекунд, работает незаметно при демонстрации экрана, распознаёт задачи с экрана интервьюера для лайвкодинга и поддерживает голосовое управление через горячие клавиши. Приложение совместимо с большинством популярных видеоконференций: Discord, Google Meet, Microsoft Teams, Zoom (через браузер), Яндекс.Телемост, Контур.Толк, Salute Jazz и другими платформами.',
    style_body
))

# ═══════════════════════════════════════════════════════════
# SECTION 2: Key Features
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Ключевые функции и возможности', style_h1))

story.append(Paragraph(
    'ShadowHint предлагает обширный набор инструментов, который выходит далеко за рамки простого распознавания речи и генерации ответов. Платформа объединяет несколько продуктов в одном приложении, создавая комплексную экосистему для поиска работы и подготовки к собеседованиям. Рассмотрим каждую функцию подробнее.',
    style_body
))

# 2.1
story.append(add_heading('2.1 Распознавание речи в реальном времени', style_h2, level=1))
story.append(Paragraph(
    'Приложение постоянно слушает аудиопоток собеседования через микрофон компьютера. Система распознавания речи (ASR - Automatic Speech Recognition) преобразует устные вопросы интервьюера в текст в режиме реального времени. Это фундаментальная функция, на которой строится весь пайплайн: без точного распознавания речи невозможно сформировать релевантные подсказки. Распознавание работает непрерывно в течение всей сессии собеседования, активируясь автоматически при начале интервью.',
    style_body
))

# 2.2
story.append(add_heading('2.2 ИИ-генерация подсказок (236 мс)', style_h2, level=1))
story.append(Paragraph(
    'После распознавания вопроса система отправляет текст в языковую модель (LLM), которая генерирует структурированный ответ. Заявленное время отклика - 236 миллисекунд, что обеспечивает практически мгновенное появление подсказки на экране. Такой показатель достигается за счёт оптимизированного пайплайна: распознанный текст немедленно передаётся в модель без промежуточных задержек, а результат отображается в компактном оверлейном окне, которое пользователь может читать параллельно с ответом на вопрос.',
    style_body
))

# 2.3
story.append(add_heading('2.3 Скрытый режим (Stealth Mode)', style_h2, level=1))
story.append(Paragraph(
    'Одна из ключевых особенностей ShadowHint - полная незаметность для интервьюера. Приложение работает в фоновом режиме и не отображается при демонстрации экрана. Это достигается за счёт использования системных API для создания окон, которые исключаются из screen sharing. В платной версии для Windows доступна кастомизация иконки и названия приложения в диспетчере задач, что делает его обнаружение ещё более затруднительным. Разработчики подчёркивают "100% незаметность" как одно из главных преимуществ.',
    style_body
))

# 2.4
story.append(add_heading('2.4 Распознавание задач с экрана (Live Coding)', style_h2, level=1))
story.append(Paragraph(
    'Помимо аудио, ShadowHint способен анализировать содержимое экрана интервьюера. Когда собеседующий демонстрирует задачу или код, приложение "читает" экран и распознаёт условия задачи. Это особенно полезно при лайвкодинг-интервью, когда кандидат должен решать алгоритмические задачи в реальном времени. Система извлекает текст задачи, анализирует его и генерирует решение или подсказки по подходу к решению.',
    style_body
))

# 2.5
story.append(add_heading('2.5 Банк вопросов (13000+ вопросов)', style_h2, level=1))
story.append(Paragraph(
    'Платформа включает обширную базу вопросов с собеседований топовых компаний - более 13 000 вопросов по программированию, алгоритмам, структурам данных и системному дизайну. Пользователи могут практиковаться, записывать ответы, получать детальный анализ от ИИ и отслеживать прогресс. Этот функционал превращает ShadowHint из инструмента "читерства" в образовательную платформу для подготовки.',
    style_body
))

# 2.6
story.append(add_heading('2.6 Автоотклики на hh.ru', style_h2, level=1))
story.append(Paragraph(
    'Дополнительный продукт в экосистеме ShadowHint - автоматизация откликов на вакансии портала hh.ru. Система автоматически находит подходящие вакансии по заданным критериям и отправляет персонализированные отклики. Бесплатная версия позволяет отправлять до 10 откликов в день, платная - до 200 откликов, а также включает автоподнятие резюме. Это существенно экономит время при поиске работы, позволяя охватить тысячи вакансий без ручного труда.',
    style_body
))

# 2.7
story.append(add_heading('2.7 Fokus Blocker', style_h2, level=1))
story.append(Paragraph(
    'Ещё один продукт из линейки - Fokus Blocker, блокировщик отвлекающих факторов. Это инструмент для концентрации внимания, который помогает пользователям оставаться сфокусированными во время подготовки к собеседованиям или при выполнении задач. Он дополняет основную функциональность платформы, создавая комплексную среду для продуктивной работы.',
    style_body
))

# Feature comparison table
story.append(Spacer(1, 18))
feature_headers = ['Функция', 'Бесплатный тариф', 'Безлимитный тариф']
feature_rows = [
    ['Использование', 'До 15 мин/мес', 'Безлимит'],
    ['Подсказки ИИ', 'Да', 'Да'],
    ['Скрытый режим', 'Да', 'Да'],
    ['Автоотклики на hh.ru', '10 в день', '200 в день + автоподъём'],
    ['Банк вопросов', 'Да', 'Да'],
    ['Кастомизация в диспетчере задач', 'Нет', 'Да (Windows)'],
    ['Загрузка резюме и контекста', 'Нет', 'Да'],
    ['Поддержка в Telegram', 'Да', 'Да'],
]
t = make_table(feature_headers, feature_rows, [0.40, 0.30, 0.30])
story.append(t)
story.append(Paragraph('Таблица 1. Сравнение тарифов ShadowHint', style_caption))
story.append(Spacer(1, 18))

# ═══════════════════════════════════════════════════════════
# SECTION 3: Technical Architecture
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Техническая архитектура', style_h1))

story.append(Paragraph(
    'Анализ сайта и структуры приложения позволяет реконструировать техническую архитектуру ShadowHint. Проект построен по классической схеме клиент-серверного приложения с десктопным клиентом, серверной частью для обработки ИИ-запросов и веб-сайтом для маркетинга и управления подписками.',
    style_body
))

story.append(add_heading('3.1 Клиентская часть (Desktop App)', style_h2, level=1))
story.append(Paragraph(
    'Десктопное приложение является ключевым компонентом системы. Оно устанавливается на компьютер пользователя (Windows или macOS) и выполняет несколько критических функций: захват аудио с микрофона, захват экрана для распознавания задач, отображение оверлейных подсказок и обеспечение скрытного режима. Вероятно, приложение разработано на Electron или Tauri, учитывая необходимость глубокого доступа к системным API для захвата аудио и экрана, а также для реализации stealth-режима (исключение окна из screen sharing). Для macOS приложение распространяется через прямой download (.dmg), а не через Mac App Store, что объясняется политикой Apple в отношении подобных приложений.',
    style_body
))

story.append(add_heading('3.2 Серверная часть (Backend)', style_h2, level=1))
story.append(Paragraph(
    'Серверная архитектура включает несколько ключевых компонентов. Сервер ASR (Automatic Speech Recognition) принимает аудиопоток от клиента и возвращает распознанный текст. Вероятно, используется одна из современных моделей: Whisper (OpenAI), Google Speech-to-Text или российские аналоги вроде SaluteSpeech от Сбер. Сервер LLM (Large Language Model) принимает распознанный текст вопроса и генерирует структурированный ответ. Это может быть собственная модель, развёрнутая на GPU-серверах, или API к коммерческим моделям (GPT-4, Claude, YandexGPT и др.). Сервер подписок и аутентификации управляет учётными записями пользователей, тарифами и доступом к функциям. Домен offer.gernar.ru, указанный в preconnect сайта, вероятно, отвечает за платёжную систему и управление подписками.',
    style_body
))

story.append(add_heading('3.3 Веб-сайт (Frontend)', style_h2, level=1))
story.append(Paragraph(
    'Веб-сайт shadowhint.com построен на Next.js с Server-Side Rendering. Это подтверждается путями к статическим ресурсам (/_next/static/chunks/), наличием манифеста (manifest.json) и структурой HTML. Сайт использует Tailwind CSS для стилизации, Lucide Icons для иконок и Sonner для уведомлений (toast-сообщения). Аналитика реализована через Яндекс.Метрику (счётчик 103160733). Хостинг изображений осуществляется через Unsplash и собственные ресурсы. Вся цветовая схема - тёмная с фиолетовыми акцентами (#7c3aed, interview-purple), что создаёт ассоциацию с технологичностью и инновационностью.',
    style_body
))

# Architecture table
story.append(Spacer(1, 18))
arch_headers = ['Компонент', 'Технология', 'Назначение']
arch_rows = [
    ['Десктопное приложение', 'Electron / Tauri', 'Захват аудио, экрана, оверлей, stealth-режим'],
    ['ASR-сервер', 'Whisper / SaluteSpeech', 'Распознавание речи в реальном времени'],
    ['LLM-сервер', 'GPT-4 / YandexGPT / Claude', 'Генерация ответов на вопросы'],
    ['Веб-сайт', 'Next.js + Tailwind CSS', 'Маркетинг, подписки, лендинг'],
    ['Платёжная система', 'offer.gernar.ru', 'Управление подписками и оплатой'],
    ['Аналитика', 'Яндекс.Метрика', 'Отслеживание посещений и конверсий'],
    ['OCR-модуль', 'Tesseract / PaddleOCR', 'Распознавание текста на экране'],
]
t = make_table(arch_headers, arch_rows, [0.25, 0.30, 0.45])
story.append(t)
story.append(Paragraph('Таблица 2. Предполагаемая техническая архитектура ShadowHint', style_caption))
story.append(Spacer(1, 18))

# ═══════════════════════════════════════════════════════════
# SECTION 4: How it works
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Принцип работы: пайплайн от аудио к подсказке', style_h1))

story.append(Paragraph(
    'Работа ShadowHint представляет собой непрерывный пайплайн обработки данных, который можно разделить на четыре основных этапа. Каждый этап оптимизирован для минимальной задержки, чтобы обеспечить подсказку практически в реальном времени.',
    style_body
))

story.append(add_heading('4.1 Этап 1: Захват аудио', style_h2, level=1))
story.append(Paragraph(
    'Приложение захватывает аудиопоток с микрофона компьютера в формате, подходящем для распознавания речи. Аудио буферизуется и отправляется на ASR-сервер частями для потокового распознавания. Это означает, что система не ждёт завершения фразы - она начинает распознавать речь сразу, обновляя текст по мере поступления новых аудиоданных. Потоковое распознавание критически важно для минимизации задержки между вопросом интервьюера и появлением подсказки.',
    style_body
))

story.append(add_heading('4.2 Этап 2: Распознавание речи (ASR)', style_h2, level=1))
story.append(Paragraph(
    'ASR-модель преобразует аудиосигнал в текст. Современные модели распознавания речи, такие как Whisper, обеспечивают высокую точность даже при шумном фоне и акцентах. Результатом является текстовая транскрипция вопросов интервьюера, которая передаётся на следующий этап. Важным аспектом является определение окончания вопроса: система должна понимать, когда интервьюер закончил формулировать вопрос и ожидает ответа, чтобы отправить полный контекст в LLM.',
    style_body
))

story.append(add_heading('4.3 Этап 3: Генерация ответа (LLM)', style_h2, level=1))
story.append(Paragraph(
    'Распознанный текст вопроса передаётся в языковую модель с системным промптом, который определяет формат и содержание ответа. Промпт, вероятно, содержит инструкции по структурированию ответа (краткий, технически точный, с примерами кода при необходимости), контекст роли (разработчик определённого уровня), и, возможно, загруженное пользователем резюме для персонализации ответов. LLM генерирует ответ за доли секунды, и результат немедленно отправляется клиенту.',
    style_body
))

story.append(add_heading('4.4 Этап 4: Отображение подсказки (Overlay)', style_h2, level=1))
story.append(Paragraph(
    'Сгенерированный ответ отображается в компактном оверлейном окне на экране пользователя. Это окно не захватывается при демонстрации экрана (screen sharing), что обеспечивает незаметность. Пользователь может читать подсказку параллельно с устным ответом, используя её как опору. Система также поддерживает горячие клавиши для активации и деактивации помощи, а также для переключения между различными типами подсказок (краткий ответ, развёрнутый, пример кода).',
    style_body
))

# ═══════════════════════════════════════════════════════════
# SECTION 5: Monetization
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Монетизация и бизнес-модель', style_h1))

story.append(Paragraph(
    'ShadowHint использует модель подписки (SaaS) с двумя тарифными планами. Бесплатный тариф предоставляет ограниченный доступ (до 15 минут использования в месяц, 10 автооткликов в день) и служит как пробная версия для привлечения пользователей. Платный тариф "Безлимитный" стоит 2 499 рублей в месяц и предоставляет полный доступ ко всем функциям без ограничений. Доступны скидки при оформлении подписки на 3 месяца (4 999 рублей) или на год (11 999 рублей).',
    style_body
))
story.append(Paragraph(
    'Дополнительный канал монетизации - реферальная программа, предлагающая 50% от стоимости подписки привлечённого пользователя. Это создаёт вирусный цикл распространения: каждый пользователь финансово мотивирован рекомендовать продукт знакомым. Такая стратегия особенно эффективна в узких профессиональных сообществах, где разработчики активно общаются между собой.',
    style_body
))

# Pricing table
story.append(Spacer(1, 18))
price_headers = ['Тариф', 'Цена', 'Ключевые ограничения']
price_rows = [
    ['Бесплатный', '0 руб.', '15 мин/мес, 10 откликов/день'],
    ['Безлимит (1 мес)', '2 499 руб.', 'Без ограничений'],
    ['Безлимит (3 мес)', '4 999 руб.', 'Без ограничений, скидка 33%'],
    ['Безлимит (1 год)', '11 999 руб.', 'Без ограничений, скидка 60%'],
]
t = make_table(price_headers, price_rows, [0.30, 0.25, 0.45])
story.append(t)
story.append(Paragraph('Таблица 3. Тарифы ShadowHint', style_caption))
story.append(Spacer(1, 18))

# ═══════════════════════════════════════════════════════════
# SECTION 6: MVP Implementation
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Реализация MVP: постоянно слушающий ИИ-помощник', style_h1))

story.append(Paragraph(
    'Теперь перейдём к главному вопросу: можно ли реализовать подобное приложение как MVP - упрощённого ИИ-помощника, который постоянно слушает и интерактивно отвечает на вопросы, без сложных настроек приватности и скрытного режима? Ответ - да, абсолютно. Более того, базовая функциональность значительно проще, чем полный ShadowHint, и может быть реализована за 2-4 недели разработки.',
    style_body
))

story.append(add_heading('6.1 Концепция MVP', style_h2, level=1))
story.append(Paragraph(
    'MVP-версия будет представлять собой десктопное или веб-приложение, которое постоянно слушает аудиопоток (через микрофон), распознаёт речь, определяет моменты вопросов и генерирует контекстные ответы с помощью ИИ. В отличие от ShadowHint, нам не нужен скрытный режим, стелс-оверлей, кастомизация диспетчера задач или интеграция с видеоконференциями. Это радикально упрощает реализацию.',
    style_body
))
story.append(Paragraph(
    'Ключевое отличие MVP от ShadowHint - открытый формат. Это не "читерский" инструмент, а легитимный помощник, аналогичный Grammarly для письма или Copilot для программирования. Пользователь может использовать его открыто: для подготовки к собеседованиям, обучения, консультаций во время звонков, или как виртуального собеседника для тренировки навыков коммуникации.',
    style_body
))

story.append(add_heading('6.2 Упрощённая архитектура MVP', style_h2, level=1))
story.append(Paragraph(
    'Архитектура MVP состоит из трёх основных компонентов: клиентского приложения, ASR-сервиса и LLM-сервиса. Рассмотрим каждый компонент подробнее.',
    style_body
))

# MVP Architecture table
story.append(Spacer(1, 12))
mvp_headers = ['Компонент', 'Технология', 'Обоснование']
mvp_rows = [
    ['Клиентское приложение', 'Next.js (веб) или Electron (десктоп)', 'Веб-версия быстрее в разработке; Electron даёт доступ к микрофону'],
    ['ASR-сервис', 'Whisper API (OpenAI) / SaluteSpeech', 'Высокая точность, готовый API, потоковый режим'],
    ['LLM-сервис', 'GPT-4o-mini / Claude Haiku / YandexGPT', 'Быстрая генерация, низкая стоимость, русскоязычная поддержка'],
    ['Хранение данных', 'SQLite (локально) / PostgreSQL (сервер)', 'История对话ов, настройки пользователя'],
    ['Аутентификация', 'NextAuth / Supabase Auth', 'Быстрая интеграция, готовые провайдеры'],
]
t = make_table(mvp_headers, mvp_rows, [0.22, 0.33, 0.45])
story.append(t)
story.append(Paragraph('Таблица 4. Архитектура MVP', style_caption))
story.append(Spacer(1, 18))

story.append(add_heading('6.3 Пайплайн работы MVP', style_h2, level=1))
story.append(Paragraph(
    'Пайплайн MVP проще, чем у ShadowHint, поскольку нам не нужен скрытный режим, захват экрана или интеграция с видеоконференциями. Основной цикл работы выглядит следующим образом.',
    style_body
))

pipeline_headers = ['Шаг', 'Действие', 'Технология', 'Задержка']
pipeline_rows = [
    ['1', 'Захват аудио с микрофона', 'Web Audio API / MediaStream', '< 10 мс'],
    ['2', 'Потоковое распознавание речи', 'Whisper API (streaming)', '200-500 мс'],
    ['3', 'Определение конца вопроса', 'Анализ паузы / VAD', '300-800 мс'],
    ['4', 'Генерация ответа LLM', 'GPT-4o-mini / Claude', '500-1500 мс'],
    ['5', 'Отображение в интерфейсе', 'React / DOM update', '< 50 мс'],
]
t = make_table(pipeline_headers, pipeline_rows, [0.08, 0.30, 0.35, 0.27])
story.append(t)
story.append(Paragraph('Таблица 5. Пайплайн MVP и ожидаемые задержки', style_caption))
story.append(Spacer(1, 18))

story.append(Paragraph(
    'Общая задержка от окончания вопроса до появления подсказки составит примерно 1-3 секунды. Это несколько медленнее, чем у ShadowHint (236 мс), но для MVP-версии абсолютно приемлемо. Оптимизация задержки - задача следующих итераций.',
    style_body
))

# ═══════════════════════════════════════════════════════════
# SECTION 7: Implementation Steps
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Пошаговый план реализации MVP', style_h1))

story.append(add_heading('7.1 Неделя 1: Базовая инфраструктура', style_h2, level=1))

story.append(Paragraph('<b>Задача:</b> Создать каркас приложения с захватом аудио и базовым UI.', style_body))
story.append(Paragraph('1. Развёртывание Next.js проекта с TypeScript и Tailwind CSS.', style_bullet))
story.append(Paragraph('2. Реализация страницы с кнопкой "Начать слушание" и областью отображения транскрипции.', style_bullet))
story.append(Paragraph('3. Интеграция Web Audio API для захвата аудиопотока с микрофона браузера.', style_bullet))
story.append(Paragraph('4. Настройка потокового соединения с ASR-сервисом через WebSocket.', style_bullet))
story.append(Paragraph('5. Отображение распознанного текста в реальном времени (сегмент "Собеседник говорит...").', style_bullet))

story.append(add_heading('7.2 Неделя 2: Интеграция LLM и генерация ответов', style_h2, level=1))

story.append(Paragraph('<b>Задача:</b> Подключить языковую модель для генерации контекстных ответов.', style_body))
story.append(Paragraph('1. Реализация серверного API-эндпоинта для вызова LLM (через z-ai-web-dev-sdk или прямое API).', style_bullet))
story.append(Paragraph('2. Разработка системного промпта: "Ты - ИИ-ассистент, который помогает отвечать на вопросы. Формируй краткие, точные, структурированные ответы."', style_bullet))
story.append(Paragraph('3. Реализация определения окончания вопроса (Voice Activity Detection - пауза более 1.5 секунд).', style_bullet))
story.append(Paragraph('4. Потоковая генерация ответа с отображением по мере поступления токенов (streaming).', style_bullet))
story.append(Paragraph('5. Добавление области "Подсказка ИИ" для отображения сгенерированного ответа.', style_bullet))

story.append(add_heading('7.3 Неделя 3: Улучшение UX и контекст', style_h2, level=1))

story.append(Paragraph('<b>Задача:</b> Улучшить пользовательский опыт и добавить поддержку контекста.', style_body))
story.append(Paragraph('1. Добавление истории диалога (контекстное окно для LLM с предыдущими вопросами и ответами).', style_bullet))
story.append(Paragraph('2. Реализация возможности загрузки резюме / профиля пользователя для персонализации ответов.', style_bullet))
story.append(Paragraph('3. Добавление переключателя режимов: "Техническое интервью", "Behavioural interview", "Свободная беседа".', style_bullet))
story.append(Paragraph('4. Добавление горячих клавиш: пробел для паузы, Enter для ручной отправки вопроса, Escape для очистки.', style_bullet))
story.append(Paragraph('5. Адаптивный дизайн для мобильных устройств.', style_bullet))

story.append(add_heading('7.4 Неделя 4: Полировка и деплой', style_h2, level=1))

story.append(Paragraph('<b>Задача:</b> Финализация MVP, тестирование и развёртывание.', style_body))
story.append(Paragraph('1. Аутентификация пользователей (NextAuth с Google/GitHub провайдерами).', style_bullet))
story.append(Paragraph('2. Лимиты использования (бесплатный тиер с ограничением запросов в день).', style_bullet))
story.append(Paragraph('3. Развёртывание на Vercel (фронтенд) и отдельном сервере (бэкенд с GPU для LLM).', style_bullet))
story.append(Paragraph('4. Тестирование с реальными сценариями: технические интервью, презентации, консультации.', style_bullet))
story.append(Paragraph('5. Базовая аналитика (отслеживание использования, популярные темы вопросов).', style_bullet))

# ═══════════════════════════════════════════════════════════
# SECTION 8: Code Examples
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Примеры кода для ключевых компонентов', style_h1))

story.append(add_heading('8.1 Захват аудио (клиентская часть)', style_h2, level=1))
story.append(Paragraph(
    'Для захвата аудио в веб-приложении используется Web Audio API в сочетании с MediaStream API. Этот подход обеспечивает доступ к микрофону браузера без необходимости установки десктопного приложения. Ниже приведена концептуальная реализация.',
    style_body
))

code_style = ParagraphStyle('Code', fontName='SarasaMonoSC', fontSize=8.5, leading=13, textColor=TEXT_PRIMARY, backColor=BG_PAGE, leftIndent=12, rightIndent=12, spaceBefore=6, spaceAfter=6, wordWrap='CJK')

code1 = """// Захват аудио и отправка на ASR-сервер
const startListening = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  const ws = new WebSocket('wss://your-server/asr/stream');
  
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) ws.send(e.data);
  };
  mediaRecorder.start(250); // отправляем чанки каждые 250мс
  
  ws.onmessage = (event) => {
    const { text, isFinal } = JSON.parse(event.data);
    updateTranscription(text, isFinal);
  };
};"""

for line in code1.strip().split('\n'):
    story.append(Paragraph(line.replace(' ', '&nbsp;').replace('<', '&lt;').replace('>', '&gt;'), code_style))

story.append(add_heading('8.2 Серверный API для LLM (Next.js API Route)', style_h2, level=1))
story.append(Paragraph(
    'Серверная часть отвечает за вызов языковой модели и потоковую передачу ответа клиенту. Ключевой момент - использование streaming для сокращения воспринимаемой задержки: пользователь видит ответ по мере генерации токенов, а не ждёт полного завершения.',
    style_body
))

code2 = """// app/api/ask/route.ts - Server-side LLM call
import ZAI from 'z-ai-web-dev-sdk';
export async function POST(req: Request) {
  const { question, context } = await req.json();
  const zai = await ZAI.create();
  const stream = await zai.chat.completions.create({
    messages: [
      { role: 'system', content: 'You are an AI interview assistant...' },
      { role: 'user', content: question }
    ],
    stream: true,
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  });
}"""

for line in code2.strip().split('\n'):
    story.append(Paragraph(line.replace(' ', '&nbsp;').replace('<', '&lt;').replace('>', '&gt;'), code_style))

story.append(add_heading('8.3 Компонент чата с подсказками (React)', style_h2, level=1))
story.append(Paragraph(
    'Основной UI-компонент отображает транскрипцию речи собеседника в реальном времени и подсказки ИИ. Компонент использует хуки React для управления состоянием и эффектами.',
    style_body
))

code3 = """// components/AssistantChat.tsx
const AssistantChat = () => {
  const [transcription, setTranscription] = useState('');
  const [hint, setHint] = useState('');
  const [isListening, setIsListening] = useState(false);
  
  const toggleListening = async () => {
    if (!isListening) {
      await startListening((text, isFinal) => {
        setTranscription(prev => isFinal ? prev + text : text);
        if (isFinal) generateHint(text);
      });
    } else {
      stopListening();
    }
    setIsListening(!isListening);
  };
  // ... render UI
};"""

for line in code3.strip().split('\n'):
    story.append(Paragraph(line.replace(' ', '&nbsp;').replace('<', '&lt;').replace('>', '&gt;'), code_style))

# ═══════════════════════════════════════════════════════════
# SECTION 9: Comparison with ShadowHint
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Сравнение MVP с ShadowHint', style_h1))

story.append(Paragraph(
    'Ниже представлено сравнение планируемого MVP с полным функционалом ShadowHint. Как видно, MVP покрывает ядро функциональности, опуская функции, которые сложны в реализации или не являются необходимыми для первого запуска.',
    style_body
))

story.append(Spacer(1, 12))
comp_headers = ['Аспект', 'ShadowHint (полный)', 'MVP-версия']
comp_rows = [
    ['Платформа', 'Десктоп (Windows, macOS)', 'Веб-приложение (браузер)'],
    ['Распознавание речи', 'Собственный ASR-сервер', 'Whisper API / SaluteSpeech API'],
    ['Генерация ответов', 'Оптимизированный LLM-пайплайн (236 мс)', 'Стандартный LLM API (1-3 сек)'],
    ['Скрытный режим', 'Полный стелс + кастомизация', 'Не нужен (открытый помощник)'],
    ['Захват экрана', 'OCR задач с экрана', 'Не в MVP (добавляется позже)'],
    ['Видеоконференции', 'Интеграция с 15+ платформами', 'Работает рядом с любой платформой'],
    ['Банк вопросов', '13 000+ вопросов', 'Не в MVP (добавляется позже)'],
    ['Автоотклики hh.ru', '10-200 откликов/день', 'Не в MVP'],
    ['Монетизация', 'Подписка 2 499 руб./мес', 'Freemium / подписка'],
    ['Срок разработки', '6-12 месяцев', '2-4 недели'],
]
t = make_table(comp_headers, comp_rows, [0.22, 0.39, 0.39])
story.append(t)
story.append(Paragraph('Таблица 6. Сравнение ShadowHint и MVP-версии', style_caption))
story.append(Spacer(1, 18))

# ═══════════════════════════════════════════════════════════
# SECTION 10: Cost Estimation
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Оценка стоимости запуска MVP', style_h1))

story.append(Paragraph(
    'Стоимость запуска MVP-версии ИИ-помощника значительно ниже, чем полного продукта типа ShadowHint, поскольку мы используем облачные API вместо собственной инфраструктуры. Ниже приведена оценка ежемесячных затрат при базовой нагрузке.',
    style_body
))

story.append(Spacer(1, 12))
cost_headers = ['Статья расходов', 'Вариант', 'Стоимость/мес']
cost_rows = [
    ['Хостинг фронтенда', 'Vercel Pro', '20 USD'],
    ['Хостинг бэкенда', 'Railway / Render', '5-20 USD'],
    ['ASR (распознавание речи)', 'Whisper API (100 часов)', '36 USD'],
    ['LLM (генерация ответов)', 'GPT-4o-mini (10 000 запросов)', '15-30 USD'],
    ['База данных', 'Supabase Free / PlanetScale', '0-25 USD'],
    ['Домен + SSL', 'Cloudflare / Namecheap', '1-2 USD'],
    ['Итого', '', '77-133 USD/мес'],
]
t = make_table(cost_headers, cost_rows, [0.35, 0.35, 0.30])
story.append(t)
story.append(Paragraph('Таблица 7. Оценка ежемесячных расходов MVP', style_caption))
story.append(Spacer(1, 18))

story.append(Paragraph(
    'При росте пользовательской базы стоимость будет увеличиваться пропорционально использованию API. Однако при цене подписки в 500-1500 рублей в месяц достаточно 10-20 платящих пользователей, чтобы покрыть расходы. Точка безубыточности при начальной цене подписки 1000 руб./мес составляет примерно 10-15 платящих пользователей.',
    style_body
))

# ═══════════════════════════════════════════════════════════
# SECTION 11: Risks and Ethics
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Риски и этические аспекты', style_h1))

story.append(add_heading('11.1 Юридические риски', style_h2, level=1))
story.append(Paragraph(
    'Использование ИИ-помощников на собеседованиях находится в серой правовой зоне. Большинство компаний считают использование внешних подсказок на интервью нарушением правил. Однако MVP-версия, позиционируемая как открытый помощник для подготовки и обучения, избегает этой проблемы. Важно чётко обозначить в условиях использования, что продукт предназначен для практики и подготовки, а не для обмана на реальных собеседованиях.',
    style_body
))

story.append(add_heading('11.2 Технические риски', style_h2, level=1))
story.append(Paragraph(
    'Основной технический риск - задержка генерации ответов. Если подсказка появляется через 3-5 секунд после вопроса, её ценность снижается. Для решения этой проблемы можно использовать предварительную генерацию (pre-generation) - система начинает формировать ответ ещё до завершения вопроса, основываясь на частичной транскрипции. Также важно обеспечить стабильность ASR-сервиса и обработку сбоев без потери контекста диалога.',
    style_body
))

story.append(add_heading('11.3 Конкурентные риски', style_h2, level=1))
story.append(Paragraph(
    'Рынок ИИ-ассистентов для собеседований активно растёт: помимо ShadowHint, существуют такие продукты как Interview Copilot, Google Interview Warmup и другие. Конкурентное преимущество MVP может заключаться в открытости (легитимный инструмент подготовки, а не скрытый чит), качестве русскоязычной поддержки и интеграции с локальными рынками труда (hh.ru, Хабр Карьера). Фокус на образовательную ценность, а не на обман, создаёт более устойчивую бизнес-модель.',
    style_body
))

# ═══════════════════════════════════════════════════════════
# SECTION 12: Conclusion
# ═══════════════════════════════════════════════════════════
story.extend(add_major_section('Заключение и рекомендации', style_h1))

story.append(Paragraph(
    'ShadowHint представляет собой комплексный продукт с продуманной экосистемой, объединяющий распознавание речи, генерацию ИИ-ответов, скрытный режим, банк вопросов и автоматизацию поиска работы. Его техническая архитектура включает десктопное приложение, ASR-сервер, LLM-сервер и веб-платформу, что требует значительных ресурсов для разработки и поддержки.',
    style_body
))
story.append(Paragraph(
    'Однако для создания MVP достаточно реализовать ядро функциональности: захват аудио, распознавание речи и генерацию ответов через API. Без скрытного режима, захвата экрана и сложных интеграций, реализация занимает 2-4 недели и стоит 77-133 USD в месяц на эксплуатацию. Ключевые рекомендации для успешного запуска.',
    style_body
))
story.append(Paragraph('1. Начать с веб-версии (Next.js + браузерный микрофон) для минимального времени до запуска.', style_bullet))
story.append(Paragraph('2. Использовать готовые API (Whisper, GPT-4o-mini) вместо развёртывания собственных моделей.', style_bullet))
story.append(Paragraph('3. Позиционировать продукт как открытый инструмент подготовки и обучения, а не скрытый помощник для обмана.', style_bullet))
story.append(Paragraph('4. Добавить поддержку контекста (загрузка резюме, история диалога) для повышения качества ответов.', style_bullet))
story.append(Paragraph('5. Запустить с минимальной монетизацией (freemium) и итеративно добавлять функции по запросу пользователей.', style_bullet))

# ═══════════════════════════════════════════════════════════
# BUILD
# ═══════════════════════════════════════════════════════════

doc.multiBuild(story)
print(f"Body PDF generated: {OUTPUT_BODY}")
