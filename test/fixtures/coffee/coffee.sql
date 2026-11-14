-- The coffee shop benchmark, as a user runs it in a tab: its data made from the generator's two CSVs on GitHub
-- (https://github.com/JosueBogran/coffeeshopdatagenerator) and getvariable('num_rows') orders, then its 10 queries.
-- onelake-writes.test.mjs runs each statement in turn, its tables named in the run's own schema.



CREATE TABLE IF NOT EXISTS dim_locations AS
SELECT * FROM 'https://raw.githubusercontent.com/JosueBogran/coffeeshopdatagenerator/refs/heads/main/Dim_Locations_Table.csv';



CREATE TABLE IF NOT EXISTS dim_products AS
SELECT * FROM 'https://raw.githubusercontent.com/JosueBogran/coffeeshopdatagenerator/refs/heads/main/Dim_Products_Table.csv';



CREATE TABLE IF NOT EXISTS fact_sales AS
-- Step 1: base orders
WITH base AS (
    SELECT
        id,
        md5(CAST(id AS VARCHAR) || '_' || random()) AS Order_ID,
        DATE '2023-01-01' + CAST(random() * 730 AS INTEGER) AS Order_Date,
        random() AS rand_lines,
        random() AS rand_tod,
        random() AS rand_loc
    FROM generate_series(0, getvariable('num_rows') - 1) tbl(id)
),
base_orders AS (
    SELECT
        *,
        EXTRACT('month' FROM Order_Date) AS Month,
        CASE
            WHEN EXTRACT('month' FROM Order_Date) IN (12, 1, 2) THEN 'winter'
            WHEN EXTRACT('month' FROM Order_Date) IN (3, 4, 5) THEN 'spring'
            WHEN EXTRACT('month' FROM Order_Date) IN (6, 7, 8) THEN 'summer'
            ELSE 'fall'
        END AS Season,
        CASE
            WHEN rand_lines < 0.60 THEN 1
            WHEN rand_lines < 0.90 THEN 2
            WHEN rand_lines < 0.95 THEN 3
            WHEN rand_lines < 0.96 THEN 4
            ELSE 5
        END AS Num_Lines,
        CASE
            WHEN rand_tod < 0.50 THEN 'Morning'
            WHEN rand_tod < 0.80 THEN 'Afternoon'
            ELSE 'Night'
        END AS Time_Of_Day,
        CASE
            WHEN rand_loc < 0.30 THEN FLOOR(random() * 50) + 1
            WHEN rand_loc < 0.80 THEN FLOOR(random() * 150) + 51
            WHEN rand_loc < 0.95 THEN FLOOR(random() * 300) + 201
            ELSE FLOOR(random() * 500) + 501
        END AS Location_ID
    FROM base
),
-- Step 2: one row per order line
exploded_orders AS (
    SELECT
        b.*,
        s.value AS Line_Val
    FROM base_orders b
    JOIN LATERAL generate_series(1, b.Num_Lines) s(value) ON TRUE
),
-- Step 3: line-level randomness
final_data AS (
    SELECT
        *,
        Order_ID || '_' || CAST(Line_Val AS VARCHAR) AS Order_Line_ID,

        -- Quantity
        CASE
            WHEN random() < 0.40 THEN 1
            WHEN random() < 0.70 THEN 2
            WHEN random() < 0.85 THEN 3
            WHEN random() < 0.95 THEN 4
            ELSE 5
        END AS Quantity,

        -- Discount Rate
        CASE
            WHEN random() < 0.80 THEN 0
            ELSE FLOOR(random() * 15 + 1)
        END AS Discount_Rate,

        -- Product_ID distribution by season
        CASE
            WHEN Season = 'summer' THEN
                CASE
                    WHEN random() < 0.40 THEN (CASE FLOOR(random() * 2) WHEN 0 THEN 5 ELSE 6 END)
                    WHEN random() < 0.90 THEN (ARRAY[1,2,3,4,7,8,9,10])[CAST(FLOOR(random() * 8) + 1 AS BIGINT)]
                    ELSE (ARRAY[11,12,13])[CAST(FLOOR(random() * 3) + 1 AS BIGINT)]
                END
            ELSE
                CASE
                    WHEN random() < 0.70 THEN (ARRAY[1,2,3,4,7,8,9,10])[CAST(FLOOR(random() * 8) + 1 AS BIGINT)]
                    WHEN random() < 0.80 THEN (CASE FLOOR(random() * 2) WHEN 0 THEN 5 ELSE 6 END)
                    ELSE (ARRAY[11,12,13])[CAST(FLOOR(random() * 3) + 1 AS BIGINT)]
                END
        END AS Product_ID
    FROM exploded_orders
)
-- Step 4: the fact table
SELECT
    a.Order_ID,
    a.order_line_id,
    a.order_date,
    a.time_Of_day,
    a.season,
    b.location_id,
    c.name AS product_name,
    a.quantity,
    (c.standard_price * ((100 - discount_rate) / 100)) * a.Quantity AS sales_amount,
    a.discount_rate AS discount_percentage
FROM final_data AS a
LEFT JOIN dim_locations AS b ON (a.Location_ID = b.record_id)
LEFT JOIN dim_products  AS c ON (a.Product_ID = c.product_id AND a.Order_Date BETWEEN c.from_date AND c.to_date);



-- 1) Calculate total daily sales for each city and a 7-day rolling average.
SELECT
    f.order_date,
    l.city,
    SUM(f.sales_amount) AS total_sales,
    AVG(SUM(f.sales_amount)) OVER (
        PARTITION BY l.city
        ORDER BY f.order_date
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS rolling_7day_avg
FROM fact_sales f
JOIN dim_locations l
    ON f.location_id = l.location_id
GROUP BY
    f.order_date,
    l.city
ORDER BY
    l.city,
    f.order_date;



-- 2) For each month, rank products by total sales amount, with 1 being the highest.
WITH monthly_sales AS (
    SELECT
        DATE_TRUNC('month', f.order_date) AS sales_month,
        f.product_name,
        SUM(f.sales_amount) AS total_sales
    FROM fact_sales f
    GROUP BY
        DATE_TRUNC('month', f.order_date),
        f.product_name
)
SELECT
    sales_month,
    product_name,
    total_sales,
    RANK() OVER (PARTITION BY sales_month ORDER BY total_sales DESC) AS sales_rank
FROM monthly_sales
ORDER BY sales_month, sales_rank;



-- 3) Find the locations in each season with the highest average discount, limited to top 3.
WITH season_discount AS (
    SELECT
        l.city,
        l.state,
        f.season,
        AVG(f.discount_percentage) AS avg_discount
    FROM fact_sales f
    JOIN dim_locations l
        ON f.location_id = l.location_id
    GROUP BY
        l.city,
        l.state,
        f.season
)
SELECT
    city,
    state,
    season,
    avg_discount,
    discount_rank
FROM (
    SELECT
        city,
        state,
        season,
        avg_discount,
        DENSE_RANK() OVER (PARTITION BY season ORDER BY avg_discount DESC) AS discount_rank
    FROM season_discount
) t
WHERE discount_rank <= 3
ORDER BY season, discount_rank;



-- 4) Compare actual daily sales to standard_price and standard_cost, to show total margin.
--    Join on product_name and date range.
SELECT
    f.order_date,
    f.product_name,
    p.standard_price,
    p.standard_cost,
    SUM(f.quantity) AS total_quantity_sold,
    SUM(f.sales_amount) AS total_sales_amount,
    (p.standard_price - p.standard_cost) * SUM(f.quantity) AS theoretical_margin
FROM fact_sales f
JOIN dim_products p
    ON f.product_name = p.name
    AND f.order_date BETWEEN p.from_date AND p.to_date
GROUP BY
    f.order_date,
    f.product_name,
    p.standard_price,
    p.standard_cost
ORDER BY
    f.order_date,
    f.product_name;



-- 5) Use a window function to calculate a 30-day rolling total quantity sold per city.
WITH daily_city_qty AS (
    SELECT
        f.order_date,
        l.city,
        SUM(f.quantity) AS daily_qty
    FROM fact_sales f
    JOIN dim_locations l
        ON f.location_id = l.location_id
    GROUP BY
        f.order_date,
        l.city
)
SELECT
    order_date,
    city,
    daily_qty,
    SUM(daily_qty) OVER (
        PARTITION BY city
        ORDER BY order_date
        ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) AS rolling_30day_qty
FROM daily_city_qty
ORDER BY city, order_date;



-- 6) Monthly revenue by product category.
WITH monthly_cat AS (
    SELECT
        DATE_TRUNC('month', f.order_date) AS sales_month,
        p.category,
        SUM(f.sales_amount) AS monthly_revenue
    FROM fact_sales f
    JOIN dim_products p
        ON f.product_name = p.name
        AND f.order_date BETWEEN p.from_date AND p.to_date
    GROUP BY
        DATE_TRUNC('month', f.order_date),
        p.category
)
SELECT
    sales_month,
    category,
    monthly_revenue
FROM monthly_cat;



-- 7) Compare total sales by location in 2023 vs. 2024.
WITH yearly_sales AS (
    SELECT
        l.location_id,
        l.city,
        l.state,
        YEAR(f.order_date) AS sales_year,
        SUM(f.sales_amount) AS total_sales_year
    FROM fact_sales f
    JOIN dim_locations l
        ON f.location_id = l.location_id
    GROUP BY
        l.location_id,
        l.city,
        l.state,
        YEAR(f.order_date)
)
SELECT
    city,
    state,
    SUM(CASE WHEN sales_year = 2023 THEN total_sales_year ELSE 0 END) AS sales_2023,
    SUM(CASE WHEN sales_year = 2024 THEN total_sales_year ELSE 0 END) AS sales_2024,
    (SUM(CASE WHEN sales_year = 2024 THEN total_sales_year ELSE 0 END)
     - SUM(CASE WHEN sales_year = 2023 THEN total_sales_year ELSE 0 END)) AS yoy_diff
FROM yearly_sales
GROUP BY
    city,
    state
ORDER BY
    city,
    state;



-- 8) For each city and quarter, rank subcategories by total sales amount.
WITH city_quarter_subcat AS (
    SELECT
        l.city,
        DATE_TRUNC('quarter', f.order_date) AS sales_quarter,
        p.subcategory,
        SUM(f.sales_amount) AS total_sales
    FROM fact_sales f
    JOIN dim_locations l
        ON f.location_id = l.location_id
    JOIN dim_products p
        ON f.product_name = p.name
        AND f.order_date BETWEEN p.from_date AND p.to_date
    GROUP BY
        l.city,
        DATE_TRUNC('quarter', f.order_date),
        p.subcategory
)
SELECT
    city,
    sales_quarter,
    subcategory,
    total_sales,
    RANK() OVER (PARTITION BY city, sales_quarter ORDER BY total_sales DESC) AS subcat_rank
FROM city_quarter_subcat
ORDER BY city, sales_quarter, subcat_rank;



-- 9) Show average discount by day, and a running cumulative average discount per city.
WITH daily_discount AS (
    SELECT
        l.city,
        f.order_date,
        AVG(f.discount_percentage) AS avg_discount
    FROM fact_sales f
    JOIN dim_locations l
        ON f.location_id = l.location_id
    GROUP BY
        l.city,
        f.order_date
)
SELECT
    city,
    order_date,
    avg_discount,
    AVG(avg_discount) OVER (
        PARTITION BY city
        ORDER BY order_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumulative_avg_discount
FROM daily_discount
ORDER BY city, order_date;



-- 10) 90-day rolling count of distinct orders in each city.
WITH daily_orders AS (
    SELECT
        f.order_date,
        l.city,
        COUNT(DISTINCT f.order_id) AS daily_distinct_orders
    FROM fact_sales f
    JOIN dim_locations l
        ON f.location_id = l.location_id
    GROUP BY
        f.order_date,
        l.city
)
SELECT
    order_date,
    city,
    daily_distinct_orders,
    SUM(daily_distinct_orders) OVER (
        PARTITION BY city
        ORDER BY order_date
        ROWS BETWEEN 89 PRECEDING AND CURRENT ROW
    ) AS rolling_90d_distinct_orders
FROM daily_orders
ORDER BY city, order_date;
