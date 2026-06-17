export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      announcements: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          id: string
          is_published: boolean
          league_id: string
          published_at: string
          title: string
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_published?: boolean
          league_id: string
          published_at?: string
          title: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_published?: boolean
          league_id?: string
          published_at?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          created_at: string | null
          entity_id: string
          entity_type: string
          id: string
          new_data: Json | null
          old_data: Json | null
          session_id: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string | null
          entity_id: string
          entity_type: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          session_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          session_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      divisions: {
        Row: {
          id: string
          name: string
          season_id: string
        }
        Insert: {
          id?: string
          name: string
          season_id: string
        }
        Update: {
          id?: string
          name?: string
          season_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "divisions_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      game_rosters: {
        Row: {
          assists: number
          game_id: string
          goals: number
          id: string
          is_substitute: boolean
          pim: number
          player_id: string | null
          team_id: string
        }
        Insert: {
          assists?: number
          game_id: string
          goals?: number
          id?: string
          is_substitute?: boolean
          pim?: number
          player_id?: string | null
          team_id: string
        }
        Update: {
          assists?: number
          game_id?: string
          goals?: number
          id?: string
          is_substitute?: boolean
          pim?: number
          player_id?: string | null
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "game_rosters_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "game_rosters_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "game_rosters_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      games: {
        Row: {
          ai_recap: string | null
          away_empty_net_against: number
          away_goalie_id: string | null
          away_goalie_is_sub: boolean
          away_goals: number
          away_team_id: string
          created_at: string
          division_id: string | null
          finalized_at: string | null
          finalized_by: string | null
          game_type: Database["public"]["Enums"]["game_type"]
          home_empty_net_against: number
          home_goalie_id: string | null
          home_goalie_is_sub: boolean
          home_goals: number
          home_team_id: string
          id: string
          is_draft: boolean
          label: string | null
          result_type: Database["public"]["Enums"]["result_type"]
          round: number | null
          scheduled_at: string | null
          season_id: string
          status: Database["public"]["Enums"]["game_status"]
          three_stars: Json | null
          week: number | null
        }
        Insert: {
          ai_recap?: string | null
          away_empty_net_against?: number
          away_goalie_id?: string | null
          away_goalie_is_sub?: boolean
          away_goals?: number
          away_team_id: string
          created_at?: string
          division_id?: string | null
          finalized_at?: string | null
          finalized_by?: string | null
          game_type?: Database["public"]["Enums"]["game_type"]
          home_empty_net_against?: number
          home_goalie_id?: string | null
          home_goalie_is_sub?: boolean
          home_goals?: number
          home_team_id: string
          id?: string
          is_draft?: boolean
          label?: string | null
          result_type?: Database["public"]["Enums"]["result_type"]
          round?: number | null
          scheduled_at?: string | null
          season_id: string
          status?: Database["public"]["Enums"]["game_status"]
          three_stars?: Json | null
          week?: number | null
        }
        Update: {
          ai_recap?: string | null
          away_empty_net_against?: number
          away_goalie_id?: string | null
          away_goalie_is_sub?: boolean
          away_goals?: number
          away_team_id?: string
          created_at?: string
          division_id?: string | null
          finalized_at?: string | null
          finalized_by?: string | null
          game_type?: Database["public"]["Enums"]["game_type"]
          home_empty_net_against?: number
          home_goalie_id?: string | null
          home_goalie_is_sub?: boolean
          home_goals?: number
          home_team_id?: string
          id?: string
          is_draft?: boolean
          label?: string | null
          result_type?: Database["public"]["Enums"]["result_type"]
          round?: number | null
          scheduled_at?: string | null
          season_id?: string
          status?: Database["public"]["Enums"]["game_status"]
          three_stars?: Json | null
          week?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "games_away_goalie_id_fkey"
            columns: ["away_goalie_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_division_id_fkey"
            columns: ["division_id"]
            isOneToOne: false
            referencedRelation: "divisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_home_goalie_id_fkey"
            columns: ["home_goalie_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      league_rules: {
        Row: {
          content: Json | null
          id: string
          league_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          content?: Json | null
          id?: string
          league_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          content?: Json | null
          id?: string
          league_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "league_rules_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: true
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      leagues: {
        Row: {
          created_at: string
          id: string
          is_public: boolean
          logo_path: string | null
          name: string
          slug: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_public?: boolean
          logo_path?: string | null
          name: string
          slug: string
        }
        Update: {
          created_at?: string
          id?: string
          is_public?: boolean
          logo_path?: string | null
          name?: string
          slug?: string
        }
        Relationships: []
      }
      players: {
        Row: {
          birthdate: string | null
          created_at: string
          first_name: string
          id: string
          last_name: string
        }
        Insert: {
          birthdate?: string | null
          created_at?: string
          first_name: string
          id?: string
          last_name: string
        }
        Update: {
          birthdate?: string | null
          created_at?: string
          first_name?: string
          id?: string
          last_name?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          player_id: string | null
          role: Database["public"]["Enums"]["app_role"] | null
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          player_id?: string | null
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          player_id?: string | null
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      season_teams: {
        Row: {
          division_id: string | null
          id: string
          season_id: string
          team_id: string
        }
        Insert: {
          division_id?: string | null
          id?: string
          season_id: string
          team_id: string
        }
        Update: {
          division_id?: string | null
          id?: string
          season_id?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "season_teams_division_id_fkey"
            columns: ["division_id"]
            isOneToOne: false
            referencedRelation: "divisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "season_teams_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "season_teams_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      seasons: {
        Row: {
          created_at: string
          ends_on: string | null
          id: string
          is_active: boolean
          league_id: string
          name: string
          point_system: Json
          starts_on: string | null
        }
        Insert: {
          created_at?: string
          ends_on?: string | null
          id?: string
          is_active?: boolean
          league_id: string
          name: string
          point_system?: Json
          starts_on?: string | null
        }
        Update: {
          created_at?: string
          ends_on?: string | null
          id?: string
          is_active?: boolean
          league_id?: string
          name?: string
          point_system?: Json
          starts_on?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "seasons_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
        ]
      }
      team_players: {
        Row: {
          id: string
          injury_notes: string | null
          is_captain: boolean
          is_rookie: boolean
          is_suspended: boolean
          jersey_number: number | null
          player_id: string
          position: Database["public"]["Enums"]["player_position"]
          season_id: string
          team_id: string
        }
        Insert: {
          id?: string
          injury_notes?: string | null
          is_captain?: boolean
          is_rookie?: boolean
          is_suspended?: boolean
          jersey_number?: number | null
          player_id: string
          position?: Database["public"]["Enums"]["player_position"]
          season_id: string
          team_id: string
        }
        Update: {
          id?: string
          injury_notes?: string | null
          is_captain?: boolean
          is_rookie?: boolean
          is_suspended?: boolean
          jersey_number?: number | null
          player_id?: string
          position?: Database["public"]["Enums"]["player_position"]
          season_id?: string
          team_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_players_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_players_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_players_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          color: string | null
          created_at: string
          id: string
          league_id: string
          logo_path: string | null
          name: string
          slug: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          league_id: string
          logo_path?: string | null
          name: string
          slug: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          league_id?: string
          logo_path?: string | null
          name?: string
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_goalie_stats: {
        Row: {
          first_name: string | null
          ga: number | null
          gaa: number | null
          gp: number | null
          jersey_number: number | null
          last_name: string | null
          losses: number | null
          player_id: string | null
          season_id: string | null
          so: number | null
          team_color: string | null
          team_id: string | null
          team_name: string | null
          team_slug: string | null
          ties: number | null
          wins: number | null
        }
        Relationships: []
      }
      v_skater_stats: {
        Row: {
          a: number | null
          first_name: string | null
          g: number | null
          gp: number | null
          jersey_number: number | null
          last_name: string | null
          pim: number | null
          player_id: string | null
          position: Database["public"]["Enums"]["player_position"] | null
          pts: number | null
          season_id: string | null
          team_color: string | null
          team_id: string | null
          team_name: string | null
          team_slug: string | null
        }
        Relationships: [
          {
            foreignKeyName: "game_rosters_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "game_rosters_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "games_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      v_standings_raw: {
        Row: {
          ga: number | null
          gd: number | null
          gf: number | null
          gp: number | null
          losses: number | null
          otl: number | null
          points: number | null
          season_id: string | null
          team_color: string | null
          team_id: string | null
          team_name: string | null
          team_slug: string | null
          ties: number | null
          wins: number | null
        }
        Relationships: [
          {
            foreignKeyName: "season_teams_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "season_teams_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      v_team_game_results: {
        Row: {
          ga: number | null
          game_id: string | null
          gf: number | null
          opponent_id: string | null
          outcome: string | null
          result_type: Database["public"]["Enums"]["result_type"] | null
          season_id: string | null
          team_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      auth_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      bump_game_empty_net: {
        Args: { p_delta: number; p_game: string; p_side: string }
        Returns: undefined
      }
      bump_game_roster_stat: {
        Args: { p_col: string; p_delta: number; p_id: string }
        Returns: undefined
      }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      game_is_public_final: { Args: { p_game: string }; Returns: boolean }
      is_captain_of: {
        Args: { p_season: string; p_team: string }
        Returns: boolean
      }
      league_is_public: { Args: { p_league: string }; Returns: boolean }
      player_is_public: { Args: { p_player: string }; Returns: boolean }
      season_is_public: { Args: { p_season: string }; Returns: boolean }
    }
    Enums: {
      app_role: "league_manager" | "captain" | "scorekeeper"
      game_status:
        | "scheduled"
        | "in_progress"
        | "final"
        | "postponed"
        | "cancelled"
      game_type: "regular" | "playoff"
      penalty_class: "minor" | "major" | "misconduct"
      player_position: "F" | "D" | "G"
      result_type: "regulation" | "overtime" | "shootout"
      strength: "EV" | "PP" | "SH" | "EN"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      app_role: ["league_manager", "captain", "scorekeeper"],
      game_status: [
        "scheduled",
        "in_progress",
        "final",
        "postponed",
        "cancelled",
      ],
      game_type: ["regular", "playoff"],
      penalty_class: ["minor", "major", "misconduct"],
      player_position: ["F", "D", "G"],
      result_type: ["regulation", "overtime", "shootout"],
      strength: ["EV", "PP", "SH", "EN"],
    },
  },
} as const

