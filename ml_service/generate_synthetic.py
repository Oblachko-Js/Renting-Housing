"""Генератор синтетического датасета (адаптированная версия вашего кода)
Файл экспортирует функцию `generate_synthetic(n, out_csv=True, out_path='spb_rent_realistic.csv')`
и возвращает pandas.DataFrame
"""
import numpy as np
import pandas as pd
import random
from scipy import stats

np.random.seed(42)
random.seed(42)

# (Сокращённо: все функции и словари из вашего примера скопированы сюда)
# Для компактности я оставил импорт всех вспомогательных функций и словарей
# Вы можете подправить параметры N по умолчанию при вызове

# --- скопированные структуры данных и функции ---
districts = {
    "Центральный": {"coef": 1.35, "lat": 59.93, "lon": 30.32, "center_dist_km": 0.0},
    "Адмиралтейский": {"coef": 1.25, "lat": 59.92, "lon": 30.28, "center_dist_km": 1.5},
    "Петроградский": {"coef": 1.30, "lat": 59.97, "lon": 30.30, "center_dist_km": 2.0},
    "Московский": {"coef": 1.10, "lat": 59.89, "lon": 30.32, "center_dist_km": 4.0},
    "Приморский": {"coef": 1.05, "lat": 60.00, "lon": 30.15, "center_dist_km": 6.0},
    "Фрунзенский": {"coef": 0.95, "lat": 59.85, "lon": 30.38, "center_dist_km": 5.0},
    "Калининский": {"coef": 0.90, "lat": 60.00, "lon": 30.40, "center_dist_km": 7.0},
    "Невский": {"coef": 0.92, "lat": 59.93, "lon": 30.50, "center_dist_km": 8.0},
    "Василеостровский": {"coef": 1.20, "lat": 59.94, "lon": 30.25, "center_dist_km": 2.5},
    "Кировский": {"coef": 0.88, "lat": 59.88, "lon": 30.25, "center_dist_km": 6.5}
}

metro_stations = {
    "Невский проспект": {"coef": 1.30, "line": 2, "lat": 59.93, "lon": 30.33},
    "Гостиный двор": {"coef": 1.28, "line": 1, "lat": 59.93, "lon": 30.33},
    "Петроградская": {"coef": 1.20, "line": 2, "lat": 59.97, "lon": 30.31},
    "Московская": {"coef": 1.10, "line": 2, "lat": 59.89, "lon": 30.32},
    "Комендантский проспект": {"coef": 1.05, "line": 5, "lat": 60.01, "lon": 30.26},
    "Проспект Ветеранов": {"coef": 0.95, "line": 1, "lat": 59.84, "lon": 30.25},
    "Ладожская": {"coef": 0.97, "line": 4, "lat": 59.93, "lon": 30.44},
    "Площадь Восстания": {"coef": 1.25, "line": 1, "lat": 59.93, "lon": 30.36},
    "Чернышевская": {"coef": 1.15, "line": 1, "lat": 59.94, "lon": 30.36},
    "Спортивная": {"coef": 1.18, "line": 5, "lat": 59.95, "lon": 30.29}
}

renovation_coef = {
    "без ремонта": {"coef": 0.85, "year": 1995},
    "косметический": {"coef": 1.00, "year": 2005},
    "евроремонт": {"coef": 1.15, "year": 2015},
    "дизайнерский": {"coef": 1.30, "year": 2020}
}

furniture_coef = {
    "нет": {"coef": 0.95, "appliances": 0},
    "частично": {"coef": 1.00, "appliances": 2},
    "полностью": {"coef": 1.05, "appliances": 5}
}

amenities = {
    "balcony": {"coef": 1.02, "prob": 0.6},
    "loggia": {"coef": 1.03, "prob": 0.3},
    "separate_bathroom": {"coef": 1.01, "prob": 0.7},
    "view_to_river": {"coef": 1.04, "prob": 0.1},
    "parking": {"coef": 1.02, "prob": 0.4},
    "concierge": {"coef": 1.01, "prob": 0.2}
}

season_coef = {1:0.92,2:0.93,3:1.00,4:1.03,5:1.06,6:1.12,7:1.15,8:1.18,9:1.12,10:1.07,11:0.98,12:0.94}

build_year_ranges = {
    "Центральный": (1890, 2023),
    "Адмиралтейский": (1900, 2023),
    "Петроградский": (1910, 2023),
    "Московский": (1960, 2023),
    "Приморский": (1990, 2023),
    "Фрунзенский": (1960, 2023),
    "Калининский": (1970, 2023),
    "Невский": (1960, 2023),
    "Василеостровский": (1930, 2023),
    "Кировский": (1950, 2023)
}

# --- вспомогательные функции ---
import math

def calculate_distance(lat1, lon1, lat2, lon2):
    return np.sqrt((lat1 - lat2)**2 + (lon1 - lon2)**2) * 111


def get_build_year(district):
    min_year, max_year = build_year_ranges[district]
    old_threshold = min(1970, (min_year + max_year) // 2)
    if random.random() < 0.3 and min_year < old_threshold:
        year = np.random.randint(min_year, old_threshold)
    else:
        year = np.random.randint(max(min_year, 1970), max_year)
    return year


def calculate_age_penalty(build_year):
    age = 2024 - build_year
    if age < 5:
        return 1.05
    elif age < 10:
        return 1.02
    elif age < 20:
        return 1.00
    elif age < 40:
        return 0.97
    elif age < 60:
        return 0.93
    else:
        return 0.88


def generate_metro_line_bonus(line):
    line_bonuses = {1:1.02,2:1.01,3:1.00,4:1.00,5:1.03}
    return line_bonuses.get(line,1.0)


def generate_floor_coefficient(floor, floors_total):
    floor_ratio = floor / floors_total
    if floor == 1:
        return 0.95
    elif floor == floors_total:
        return 1.05
    elif floors_total >= 12 and floor >= floors_total - 3:
        return 1.08
    elif floor_ratio > 0.7:
        return 1.03
    elif floor_ratio < 0.3:
        return 0.98
    else:
        return 1.00


def get_area_coefficient(area):
    if area < 25:
        return 0.85 + 0.006 * area
    elif area < 40:
        return 0.97 + 0.002 * (area - 25)
    elif area < 60:
        return 1.02 + 0.0015 * (area - 40)
    elif area < 80:
        return 1.05 + 0.001 * (area - 60)
    else:
        return 1.07 + 0.0005 * (area - 80)


def get_rooms_coefficient(rooms, area):
    if rooms == 1:
        base_coef = 1.0
        if area > 40:
            base_coef = 0.95
    elif rooms == 2:
        base_coef = 1.15
        if area < 35:
            base_coef = 1.05
    elif rooms == 3:
        base_coef = 1.25
        if area < 50:
            base_coef = 1.15
    else:
        base_coef = 1.35
        if area < 65:
            base_coef = 1.25
    return base_coef * (1 + 0.01 * np.sin(area/10))


def get_season_district_interaction(month, district):
    if month in [6,7,8]:
        if district in ["Центральный","Приморский","Василеостровский"]:
            return 1.12
        elif district in ["Невский","Калининский"]:
            return 1.05
        else:
            return 1.08
    elif month in [12,1,2]:
        if district in ["Центральный","Адмиралтейский"]:
            return 0.95
        else:
            return 0.92
    else:
        return 1.0


def get_metro_distance_effect(metro_distance, district):
    base_effect = np.exp(-metro_distance * 0.025)
    if district in ["Центральный","Адмиралтейский"]:
        return base_effect ** 1.2
    elif district in ["Приморский","Калининский","Невский"]:
        return base_effect ** 0.8
    else:
        return base_effect


def get_center_distance_effect(center_distance, is_new_building):
    base_effect = np.exp(-center_distance * 0.015)
    if is_new_building and center_distance > 8:
        return base_effect * 0.95
    else:
        return base_effect


def generate_nonlinear_noise(base_price):
    noise_level = np.random.uniform(0.10, 0.20)
    if base_price > 80000:
        noise_level *= 1.3
    elif base_price < 40000:
        noise_level *= 0.8
    noise_std = base_price * noise_level
    noise = np.random.normal(0, noise_std)
    if random.random() < 0.03:
        outlier_factor = np.random.choice([0.6,0.75,1.4,1.6])
        noise = noise + base_price * (outlier_factor - 1)
    return noise


def generate_synthetic(N=1000, out_csv=True, out_path='spb_rent_realistic.csv'):
    data = []
    center_lat, center_lon = 59.93, 30.32
    district_list = list(districts.keys())
    for i in range(N):
        area = np.clip(np.random.normal(45,15), 20, 100)
        rooms = np.random.choice([1,2,3,4], p=[0.50,0.35,0.12,0.03])
        district = np.random.choice(district_list, p=[0.15,0.12,0.10,0.11,0.14,0.10,0.09,0.08,0.06,0.05])
        if district in ["Центральный","Адмиралтейский"]:
            floors_total = np.random.choice([5,6,7,9], p=[0.4,0.3,0.2,0.1])
        elif district in ["Приморский","Московский"]:
            floors_total = np.random.choice([9,12,16,25], p=[0.3,0.4,0.2,0.1])
        else:
            floors_total = np.random.choice([5,9,12], p=[0.4,0.4,0.2])
        floor = np.random.randint(1, floors_total + 1)
        district_info = districts[district]
        lat = district_info["lat"] + np.random.uniform(-0.025, 0.025)
        lon = district_info["lon"] + np.random.uniform(-0.025, 0.025)
        center_distance = calculate_distance(lat, lon, center_lat, center_lon)
        metro_candidates = list(metro_stations.keys())
        metro = np.random.choice(metro_candidates)
        if district in ["Центральный","Адмиралтейский"]:
            metro_distance = np.clip(np.random.exponential(4), 1, 12)
        elif district in ["Приморский","Калининский"]:
            metro_distance = np.clip(np.random.exponential(10), 3, 25)
        else:
            metro_distance = np.clip(np.random.exponential(7), 2, 20)
        build_year = get_build_year(district)
        house_age = 2024 - build_year
        is_new_building_flag = 1 if build_year >= 2010 else 0
        renovation = np.random.choice(list(renovation_coef.keys()), p=[0.20,0.50,0.25,0.05])
        furniture = np.random.choice(list(furniture_coef.keys()), p=[0.25,0.50,0.25])
        month = np.random.randint(1,13)
        has_balcony = 1 if random.random() < amenities["balcony"]["prob"] else 0
        has_loggia = 1 if random.random() < amenities["loggia"]["prob"] else 0
        has_separate_bathroom = 1 if random.random() < amenities["separate_bathroom"]["prob"] else 0
        has_view_to_river = 1 if random.random() < amenities["view_to_river"]["prob"] else 0
        has_parking = 1 if random.random() < amenities["parking"]["prob"] else 0
        has_concierge = 1 if random.random() < amenities["concierge"]["prob"] else 0
        amenities_coef = 1.0
        amenities_count = 0
        if has_balcony:
            amenities_coef *= amenities["balcony"]["coef"]
            amenities_count += 1
        if has_loggia:
            amenities_coef *= amenities["loggia"]["coef"]
            amenities_count += 1
        if has_separate_bathroom:
            amenities_coef *= amenities["separate_bathroom"]["coef"]
            amenities_count += 1
        if has_view_to_river:
            amenities_coef *= amenities["view_to_river"]["coef"]
            amenities_count += 1
        if has_parking:
            amenities_coef *= amenities["parking"]["coef"]
            amenities_count += 1
        if has_concierge:
            amenities_coef *= amenities["concierge"]["coef"]
            amenities_count += 1
        if amenities_count > 3:
            amenities_coef = amenities_coef ** 0.9
        base_price_per_sqm = 850 + np.random.normal(0,50)
        base_price = base_price_per_sqm * area
        area_coef = get_area_coefficient(area)
        rooms_coef = get_rooms_coefficient(rooms, area)
        age_coef = calculate_age_penalty(build_year)
        floor_coef = generate_floor_coefficient(floor, floors_total)
        metro_coef = get_metro_distance_effect(metro_distance, district)
        center_coef = get_center_distance_effect(center_distance, is_new_building_flag)
        season_district_coef = get_season_district_interaction(month, district)
        if renovation == "дизайнерский" and build_year < 1970:
            renovation_factor = 1.4
        elif renovation == "без ремонта" and build_year > 2010:
            renovation_factor = 0.8
        else:
            renovation_factor = renovation_coef[renovation]["coef"]
        if furniture == "полностью" and renovation == "дизайнерский":
            furniture_factor = 1.08
        elif furniture == "нет" and renovation in ["евроремонт","дизайнерский"]:
            furniture_factor = 0.92
        else:
            furniture_factor = furniture_coef[furniture]["coef"]
        total_coef = (
            districts[district]["coef"]
            * metro_stations[metro]["coef"] ** 0.8
            * renovation_factor
            * furniture_factor
            * season_coef[month] * season_district_coef
            * metro_coef
            * center_coef
            * age_coef
            * generate_metro_line_bonus(metro_stations[metro]["line"])
            * floor_coef
            * amenities_coef
            * area_coef
            * rooms_coef
        )
        price = base_price * total_coef
        noise = generate_nonlinear_noise(price)
        price = max(20000, price + noise)
        data.append([
            round(price,0), round(area,1), rooms, floor, floors_total,
            district, metro, round(metro_distance,1), renovation, furniture, month,
            round(lat,4), round(lon,4), round(center_distance,2), build_year,
            house_age, has_balcony, has_loggia, has_separate_bathroom,
            has_view_to_river, has_parking, has_concierge, metro_stations[metro]["line"],
            renovation_coef[renovation]["year"], furniture_coef[furniture]["appliances"]
        ])
    columns = [
        "price","area","rooms","floor","floors_total",
        "district","metro_station","metro_distance_min",
        "renovation_quality","furniture","month",
        "latitude","longitude","center_distance_km",
        "build_year","house_age","has_balcony","has_loggia",
        "has_separate_bathroom","has_view_to_river","has_parking","has_concierge",
        "metro_line","renovation_year","appliances_count"
    ]
    df = pd.DataFrame(data, columns=columns)
    df["price_per_sqm"] = df["price"] / df["area"]
    df["floor_ratio"] = df["floor"] / df["floors_total"]
    df["is_new_building"] = (df["build_year"] >= 2010).astype(int)
    df["is_center"] = (df["center_distance_km"] <= 3).astype(int)
    df["is_high_floor"] = ((df["floor"] / df["floors_total"]) > 0.7).astype(int)
    df["amenities_count"] = (df["has_balcony"] + df["has_loggia"] + df["has_separate_bathroom"] + df["has_view_to_river"] + df["has_parking"] + df["has_concierge"])
    df["is_summer"] = df["month"].isin([6,7,8]).astype(int)
    df["is_winter"] = df["month"].isin([12,1,2]).astype(int)
    df["area_rooms_interaction"] = df["area"] * df["rooms"]
    df["center_new_interaction"] = df["is_center"] * df["is_new_building"]
    df["metro_center_interaction"] = df["metro_distance_min"] * df["center_distance_km"]
    df.to_csv(out_path, index=False, encoding='utf-8') if out_csv else None
    return df


if __name__ == '__main__':
    print('Генерируем примерный набор данных...')
    generate_synthetic(1000)
    print('Сохранено spb_rent_realistic.csv')