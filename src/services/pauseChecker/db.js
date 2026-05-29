export async function fetchPauseRows({
  supabaseClient,
  schema,
  table,
  phoneColumn,
  phoneValue,
}) {
  try {
    const { data, error, status } = await supabaseClient
      .schema(schema)
      .from(table)
      .select("*")
      .eq(phoneColumn, phoneValue)
      .limit(1);

    if (error) {
      return {
        ok: false,
        status: Number(status || 500),
        rows: [],
        rawText: error.message || "erro supabase",
      };
    }

    return {
      ok: true,
      status: Number(status || 200),
      rows: Array.isArray(data) ? data : [],
      rawText: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      rows: [],
      rawText: error?.message || "erro supabase",
    };
  }
}

export async function fetchPauseRowsSample({
  supabaseClient,
  schema,
  table,
  limit = 200,
}) {
  try {
    const { data, error, status } = await supabaseClient
      .schema(schema)
      .from(table)
      .select("*")
      .limit(Math.max(1, Math.min(Number(limit || 200), 1000)));

    if (error) {
      return {
        ok: false,
        status: Number(status || 500),
        rows: [],
        rawText: error.message || "erro supabase",
      };
    }

    return {
      ok: true,
      status: Number(status || 200),
      rows: Array.isArray(data) ? data : [],
      rawText: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      rows: [],
      rawText: error?.message || "erro supabase",
    };
  }
}

export async function deletePauseRows({
  supabaseClient,
  schema,
  table,
  phoneColumn,
  phoneValue,
}) {
  try {
    const { data, error, status } = await supabaseClient
      .schema(schema)
      .from(table)
      .delete()
      .eq(phoneColumn, phoneValue)
      .select("*");

    if (error) {
      return {
        ok: false,
        status: Number(status || 500),
        rows: [],
        rawText: error.message || "erro supabase",
      };
    }

    return {
      ok: true,
      status: Number(status || 200),
      rows: Array.isArray(data) ? data : [],
      rawText: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      rows: [],
      rawText: error?.message || "erro supabase",
    };
  }
}

