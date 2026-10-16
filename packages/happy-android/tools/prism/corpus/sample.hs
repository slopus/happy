module Main where
import qualified Data.Map as M
-- | Doc comment
data Shape = Circle Double | Square Double deriving (Show, Eq)
area :: Shape -> Double
area (Circle r) = pi * r ^ 2
area (Square s) = s * s
main :: IO ()
main = mapM_ (print . area) [Circle 1.0, Square 2] {- block -}
