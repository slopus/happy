defmodule Greeter do
  @moduledoc "Greets people"
  def hello(name) when is_binary(name) do
    "Hello, #{name}!" |> IO.puts()
    {:ok, ~r/\w+/, [1, 2.5, :atom]}
  end
  # comment
  defp private_fun, do: nil
end
