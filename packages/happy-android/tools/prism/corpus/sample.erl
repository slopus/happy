-module(greeter).
-export([hello/1]).
%% comment
hello(Name) when is_list(Name) ->
    io:format("Hello, ~s!~n", [Name]),
    {ok, 42, 3.14, 'quoted atom', <<"bin">>};
hello(_) -> error.
