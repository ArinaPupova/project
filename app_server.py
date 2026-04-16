import os
# Обходим блокировки и таймауты Hugging Face в РФ
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

import json
import re
import asyncio
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from apscheduler.schedulers.asyncio import AsyncIOScheduler

import requests
import urllib3
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup
import pymorphy2
from natasha import (
    Segmenter, MorphVocab, NewsEmbedding, NewsNERTagger, Doc
)
from transformers import pipeline
from collections import Counter

# --- Конфигурация путей ---
BASE_DIR = Path(__file__).parent
CONFIG_PATH = BASE_DIR / "config" / "regions.json"
STATE_DIR = BASE_DIR / "regions_state"
GEO_DIR = BASE_DIR / "data" / "geo"
DICT_PATH = BASE_DIR / "config" / "combined_database.json"
FEEDBACK_DIR = BASE_DIR / "data" / "feedback"


for folder in [STATE_DIR, GEO_DIR, FEEDBACK_DIR]:
    folder.mkdir(parents=True, exist_ok=True)

RU_MONTHS = {
    "января": "01", "февраля": "02", "марта": "03", "апреля": "04",
    "мая": "05", "июня": "06", "июля": "07", "августа": "08",
    "сентября": "09", "октября": "10", "ноября": "11", "декабря": "12",
}

# --- Глобальные переменные ---
ml_models = {}
place_index = {}

# Отключаем предупреждения InsecureRequestWarning, если используем verify=False
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def get_requests_session():
    session = requests.Session()
    retry = Retry(connect=3, read=3, backoff_factor=1)
    adapter = HTTPAdapter(max_retries=retry)
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    })
    return session

GLOBAL_SESSION = get_requests_session()

# --- Все функции ---
def load_regions():
    try:
        if not CONFIG_PATH.exists(): return {}
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except:
        return {}

def load_state(region_id):
    path = STATE_DIR / f"{region_id}.json"
    if not path.exists(): return {"last_seen_date": None}
    try: return json.loads(path.read_text(encoding="utf-8"))
    except: return {"last_seen_date": None}

def save_state(region_id, state):
    path = STATE_DIR / f"{region_id}.json"
    path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")

# умное считывание даты. есть понимание "сегодня" - текущая дата, "вчера" - сегодня-1 день
def parse_smart_date(raw_date: str) -> datetime:
    now = datetime.now()
    raw_date = raw_date.lower().strip()
    try:
        if "сегодня" in raw_date or (len(raw_date) == 5 and ":" in raw_date):
            time_part = raw_date.split(",")[-1].strip()
            return datetime.strptime(f"{now.strftime('%d.%m.%Y')} {time_part}", "%d.%m.%Y %H:%M")
        if "вчера" in raw_date:
            time_part = raw_date.split(",")[-1].strip()
            yesterday = now - timedelta(days=1)
            return datetime.strptime(f"{yesterday.strftime('%d.%m.%Y')} {time_part}", "%d.%m.%Y %H:%M")
        
        clean_date = raw_date.replace(",", "")
        parts = clean_date.split()
        day = parts[0].zfill(2)
        month = RU_MONTHS.get(parts[1], "01")
        time_part = parts[2] if len(parts) > 2 and ":" in parts[2] else "00:00"
        year = parts[2] if len(parts) > 2 and len(parts[2]) == 4 else now.year
        return datetime.strptime(f"{day}.{month}.{year} {time_part}", "%d.%m.%Y %H:%M")
    except Exception:
        return now

# парсинг страницы новостей региона.
def parse_region_page(region_id, url):
    try:
        print(f"[DEBUG] Скачивание страницы списка новостей: {region_id} ({url})")
        response = GLOBAL_SESSION.get(url, timeout=30, verify=False)
        response.raise_for_status()
        response.encoding = 'utf-8'
        soup = BeautifulSoup(response.text, "lxml")
        items = []
        articles = soup.select(".list-item, .cell-list__item")

        for art in articles:
            title_el = art.select_one(".list-item__title, .cell-list__item-title") # поддержка нескольких классов - по сути "найди или это или то"
            date_el = art.select_one('div[data-type="date"], .cell-info__date, .list-item__date')
            if not title_el or not date_el: continue

            title = title_el.get_text(strip=True)
            url_path = title_el.get("href") or art.get("href")
            if not url_path: continue
            
            full_url = urljoin(url, url_path)
            date_raw = date_el.get_text(strip=True)
            date_obj = parse_smart_date(date_raw)

            items.append({"title": title, "date": date_obj, "url": full_url})
        return items
    except Exception as e:
        print(f"[ERROR] {region_id}: Ошибка загрузки списка — {e}")
        return []

# заглядывает в файл состояния из папки region_state последнюю фазу захода на сайт
# не обрабатывается уже обработанная новость
def find_new_items(region_id, items):
    state = load_state(region_id)
    last_seen_str = state.get("last_seen_date")
    last_seen = datetime.fromisoformat(last_seen_str) if last_seen_str else None

    items.sort(key=lambda x: x["date"])
    # new_items = []
    # for item in items:
    #     if last_seen is None or item["date"] > last_seen:
    #         new_items.append(item)

    # if new_items:
    #     newest_date = max(i["date"] for i in new_items)
    #     state["last_seen_date"] = newest_date.isoformat()
    #     save_state(region_id, state)

    return [i for i in items if last_seen is None or i["date"] > last_seen]

# обработка текста 

#отсекаем в начале новости пометку РИА новости
def clean_ria_lead(text: str) -> str:
    pattern = r'^.*?РИА Новости[.\s—-]*'
    return re.sub(pattern, '', text, flags=re.IGNORECASE).strip()

# приведение слов к именительному падежу
def normalize_location_phrase(text: str) -> str:
    words = text.split()
    normalized = []
    for word in words:
        p = ml_models["morph"].parse(word)[0] # нахождение всевозможных вариантов того, чем может быть это слово. и берется первый вариант разбора как наиболее лучшая догадка
        inflected = p.inflect({"nomn"}) # переводит к именительному падежу
        word_norm = inflected.word if inflected else p.word
        normalized.append(word_norm.capitalize()) # делает первую букву заглавной 
    return " ".join(normalized)

# извлечение упоминания городов, областей (natasha+по шаблонам), чтобы получить максимальную точность
def extract_locations(text: str):
    doc = Doc(text)
    doc.segment(ml_models["segmenter"]) # нарезка на токены
    doc.tag_ner(ml_models["ner_tagger"]) # помечаются слова которые похожи на имена, организации, локации
    locations = []
    found_normalized = set()
    for span in doc.spans:
        if span.type == "LOC": # нам интересны только локации
            span.normalize(ml_models["morph_vocab"]) # снова пытаемся привести название к начальной форме
            normalized = normalize_location_phrase(span.normal) # еще раз прогоняем через функцию нормализации
            locations.append({"name": span.text, "normalized": normalized, "source": "ner"})
            found_normalized.add(normalized.lower())
    
    region_pattern = r'\b([А-ЯЁ][а-яё]+(?:ск|цк|ицк)(?:ой|ая|ую|ого|ому|ом|ий|им|ие|ое))\s+(област[ьиью]|округ[аеуом]|район[аеуыом])\b' # шаблон для сложных случаев, подстраховка 
    for m in re.finditer(region_pattern, text):
        phrase = m.group(0)
        normalized = normalize_location_phrase(phrase)
        if normalized.lower() not in found_normalized:
            locations.append({"name": phrase, "normalized": normalized, "source": "regex"})
            found_normalized.add(normalized.lower())
    return locations

# берет очищенное название города и ищет широту и долготу в газетире
def match_locations_with_dictionary(locations):
    matched = []
    for loc in locations:
        name_lower = loc["normalized"].lower()
        if name_lower in place_index:
            place = place_index[name_lower]
            matched.append({
                "id": place.get("id"),
                "name": place["name"],
                "region": place.get("region"),
                "lat": place.get("latitude"),
                "lon": place.get("longitude"),
                "type": place.get("type"),
                "rang": place.get("rang")
            })
    return matched

# переход по ссылке конкретной новости, собирается полный текст и теги, очищается текст от мусора, нлп-анализ, сохранение геоджейсон
def parse_and_analyze_article(url, basic_info, region_id):
    try:
        response = GLOBAL_SESSION.get(url, timeout=30, verify=False)
        response.raise_for_status()
        soup = BeautifulSoup(response.content, 'html.parser')

        title_el = soup.find('div', class_='article__title')
        title = title_el.text.strip() if title_el else basic_info["title"]
        
        text_elements = soup.find_all('div', class_='article__text')
        raw_text = ' '.join([el.text.strip() for el in text_elements])
        text = clean_ria_lead(raw_text)

        tag_elements = soup.find_all('a', class_="article__tags-item") 
        tags = [tag.text.strip() for tag in tag_elements]
        
        # !!!! создание идентификатора для каждой новости !!!!!
        # ищется в ссылке фрагмент, подходящий под правило "несколько цифр подряд + расширение"
        news_id_match = re.search(r'(\d+)\.html', url)
        #если цифры найдены, то присваиваются, если нет, то превращаем строку в уникальный набор цифр
        news_id = news_id_match.group(1) if news_id_match else str(hash(url))

        if not text:
            print(f"[INFO] Текст не найден: {url}")
            return None

       # --- 1. АНАЛИЗ ТОНАЛЬНОСТИ (ГОЛОСОВАНИЕ БОЛЬШИНСТВОМ) ---
        chunk_size = 512
        chunks = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)]

        labels = []
        scores_map = [] 

        for chunk in chunks:
            try:
                res = ml_models["sentiment"](chunk)[0]
                labels.append(res['label'])
                scores_map.append(res)
            except Exception as e:
                print(f"Ошибка анализа чанка: {e}")

        if not labels:
            sentiment_res = {"label": "NEUTRAL", "score": 0.0}
        else:
            # ищем самый частый лейбл
            occurence_count = Counter(labels)
            final_label = occurence_count.most_common(1)[0][0]
            
            # Средняя уверенность только для победившего лейбла
            relevant_scores = [item['score'] for item in scores_map if item['label'] == final_label]
            avg_score = sum(relevant_scores) / len(relevant_scores)
            
            sentiment_res = {'label': final_label, 'score': avg_score}
        
        # --- 2. ИЗВЛЕЧЕНИЕ ЛОКАЦИЙ И ФИЛЬТРАЦИЯ ТЕГОВ ---
        found_locs = extract_locations(text) 
        matched_results = match_locations_with_dictionary(found_locs) 

        # Очистка тегов от географии (чтобы не дублировать локации в тегах)
        clean_tags = []
        for tag in tags: # tags здесь — это те, что мы собрали выше через soup.find_all
            normalized_tag = normalize_location_phrase(tag).lower()
            if normalized_tag not in place_index:
                clean_tags.append(tag)
        tags = clean_tags # подменяем исходный список отфильтрованным
        

        if matched_results:
            max_current_rang = max((loc['rang'] for loc in matched_results if loc['rang'] is not None), default=None)
            if max_current_rang is not None: 
                top_locations = [loc for loc in matched_results if loc['rang'] == max_current_rang]
                
                # Открываем/создаем геожсон для конкретного региона
                file_name = GEO_DIR / f"{region_id}.geojson"
                geojson_data = {"type": "FeatureCollection", "features": []}
                
                if file_name.exists():
                    try:
                        with open(file_name, "r", encoding="utf-8") as f:
                            geojson_data = json.load(f)
                    except: pass
                    
                new_features_added = False

                # формируем геоджсон        
                for loc in top_locations:
                    feature = {
                        "type": "Feature",
                        "geometry": {
                            "type": "Point",
                            "coordinates": [float(loc['lon']), float(loc['lat'])]
                        },
                        "properties": {
                            "news_id": news_id,
                            "title": title,
                            "date": basic_info["date"].isoformat(),
                            "text_preview": text[:200] + "...",
                            "tags" : tags,
                            "sentiment": sentiment_res['label'],
                            "confidence": round(sentiment_res['score'], 3),
                            "place_name": loc['name'],
                            "place_type": loc['type'],
                            "region": loc['region'],
                            "rang": loc['rang'],
                            "url": url
                        }
                    }

                    # Проверяем уникальность: в файле не должно быть этой новости для ЭТОЙ ЖЕ локации
                    is_duplicate = any(
                        f.get("properties", {}).get("news_id") == news_id and 
                        f.get("properties", {}).get("place_name") == loc['name']
                        for f in geojson_data.get("features", [])
                    )
                    
                    if not is_duplicate:
                        geojson_data.setdefault("features", []).append(feature)
                        new_features_added = True
                        
                if new_features_added:        
                    with open(file_name, "w", encoding="utf-8") as f:
                        json.dump(geojson_data, f, ensure_ascii=False, indent=4)
                    print(f"[DEBUG] Сохранен анализ в {region_id}.geojson: {title[:30]}")

    except Exception as e:
        print(f"[ERROR] Ошибка анализа {url}: {e}")

def job_parse_news():
    global LAST_UPDATE_TIME
    print(f"\n[{datetime.now().isoformat()}] === Запуск проверки ===")
    regions = load_regions()
    has_new_data = False
    
    for region_id, config in regions.items():
        url = config.get("url")
        if not url: continue
        
        items = parse_region_page(region_id, url)
        new_items = find_new_items(region_id, items)


        if new_items:
            print(f"[DEBUG] {region_id} - найдено {len(new_items)} новостей.")
            for item in new_items:
                # 2. Обработка
                parse_and_analyze_article(item["url"], item, region_id)
            
            # 3. Только после успешного цикла обработки сохраняем состояние
            newest_date = max(i["date"] for i in new_items)
            save_state(region_id, {"last_seen_date": newest_date.isoformat()})
            has_new_data = True
            
    if has_new_data:
        LAST_UPDATE_TIME = datetime.now().isoformat()
        print(f"[*] Время обновления карты изменено: {LAST_UPDATE_TIME}")
        
#  Жизненный цикл FastAPI      
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("--- Загрузка ML моделей ---") #загружаем один раз и всё
    ml_models["segmenter"] = Segmenter()
    ml_models["morph_vocab"] = MorphVocab()
    emb = NewsEmbedding()
    ml_models["ner_tagger"] = NewsNERTagger(emb)
    ml_models["morph"] = pymorphy2.MorphAnalyzer()
    
    print("Инициализация Transformers...")
    ml_models["sentiment"] = pipeline("sentiment-analysis", model="seara/rubert-base-cased-russian-sentiment")

    if DICT_PATH.exists():
        try:
            places = json.loads(DICT_PATH.read_text(encoding="utf-8"))
            for p in places:
                place_index[p["name"].lower()] = p
            print(f"Загружено {len(place_index)} топонимов.")
        except Exception as e:
            print(f"Ошибка загрузки словаря: {e}")
            pass

    print("--- Запуск планировщика ---")
    scheduler = AsyncIOScheduler()
    scheduler.add_job(job_parse_news, 'interval', minutes=15) # настраиваем таймер через каждые 15 минут
    scheduler.start()
    
    # Запускаем парсер сразу при старте, чтобы не ждать первые 15 минут
    asyncio.create_task(asyncio.to_thread(job_parse_news))
    
    yield 
    print("--- Остановка сервера ---")
    scheduler.shutdown()
    ml_models.clear() # очищает оперативку от моделей

app = FastAPI(lifespan=lifespan)
LAST_UPDATE_TIME = datetime.now().isoformat()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- API Endpoints ---

@app.get("/api/last-update")
async def get_last_update():
    """Возвращает время последнего успешного завершения цикла парсинга"""
    return {"last_update": LAST_UPDATE_TIME}
        
@app.get("/api/news") 
async def get_news(
    days: int = Query(5, description="Сколько дней назад брать новости"),
    sentiment: str = Query(None, description="Фильтр по тональности (POSITIVE, NEGATIVE, NEUTRAL)"),
    tags: str = Query(None, description="Теги через запятую")
):
    cutoff_date = datetime.now() - timedelta(days=days) # вычисление линии отсечения
    features = []
    tags_filter = set(t.strip().lower() for t in tags.split(",")) if tags else set()
    files = list(GEO_DIR.glob("*.geojson")) # все файлы из папки с регионами
    
    for file_path in files: # открывает каждый файл и перебирает новости
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            for feature in data.get("features", []):
                props = feature.get("properties", {})
                
                date_str = props.get("date")
                if date_str:
                    try:
                        feature_date = datetime.fromisoformat(date_str)
                        if feature_date < cutoff_date:
                            continue 
                    except ValueError:
                        pass 

                if sentiment and props.get("sentiment") != sentiment:
                    continue
                
                if tags_filter:
                    feature_tags = set(t.lower() for t in props.get("tags", []))
                    if not tags_filter.intersection(feature_tags):
                        continue
                        
                features.append(feature) # всё что прошло фильтр
        except Exception as e:
             pass

    return {
        "type": "FeatureCollection",
        "features": features
    } # отдает список сайту

@app.get("/api/tags") 
async def get_all_tags():
    cutoff_date = datetime.now() - timedelta(days=5)
    tags_set = set()
    files = list(GEO_DIR.glob("*.geojson"))
    
    for file_path in files:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for feature in data.get("features", []):
                props = feature.get("properties", {})
                date_str = props.get("date")
                if date_str:
                    try:
                        if datetime.fromisoformat(date_str) > cutoff_date:
                            for tag in props.get("tags", []):
                                tags_set.add(tag)
                    except ValueError:
                        pass
        except:
            pass

    return list(tags_set)

# Принимает отзыв пользователя и сохраняет в отдельный JSON-файл
@app.post("/api/feedback")
async def save_feedback(data: dict):
    news_id = data.get("news_id")
    if not news_id:
        return {"status": "error", "message": "No news_id"}

   # Создаем имя файла: feedback_ID_TIMESTAMP.json
    timestamp = int(datetime.now().timestamp())
    file_name = f"feedback_{news_id}_{timestamp}.json"
    file_path = FEEDBACK_DIR / file_name
    
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
    return {"status": "success"}

if __name__ == "__main__":
    pass
